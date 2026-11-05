// @effect-diagnostics globalFetch:off nodeBuiltinImport:off -- A plain Node app; it does not use Effect.
/**
 * Files people attach to a Linear prompt live on uploads.linear.app behind
 * signed links. The bridge downloads them with its own token and hands them to
 * T3 like Slack's and iMessage's files, under the same limits; the agent never
 * sees the links.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { EventFile } from "../bridge.ts";

const UPLOAD_HOST = "uploads.linear.app";

/** `![alt](url)` or `[name](url)` on Linear's upload host. */
const UPLOAD_LINK = /(!?)\[([^\]\n]*)\]\((https:\/\/uploads\.linear\.app\/[^\s)]+)\)/g;
/** Linear's own image tag in prompts: `<linear-image>{"type":"image","attrs":{"src":…,"title":…}}</linear-image>`. */
const IMAGE_TAG = /<linear-image>([\s\S]*?)<\/linear-image>/g;
/** An upload URL on its own. */
const UPLOAD_URL = /https:\/\/uploads\.linear\.app\/[^\s)>\]"']+/g;

export interface LinearUpload {
  readonly url: string;
  readonly name: string;
  /** Linear said it is an image, even when its name doesn't. */
  readonly image?: boolean | undefined;
}

/** The source and title of a `<linear-image>` tag's JSON; nothing when it doesn't parse. */
function imageTag(json: string): { readonly src: string; readonly title: string } | undefined {
  try {
    const attrs = (JSON.parse(json) as { readonly attrs?: Record<string, unknown> }).attrs;
    const src = attrs?.src;
    if (typeof src !== "string") return undefined;
    return { src, title: typeof attrs?.title === "string" ? attrs.title : "" };
  } catch {
    return undefined;
  }
}

/** A safe file name from a link's text or its URL's last segment. */
function uploadName(label: string, url: string): string {
  const fromUrl = (() => {
    try {
      return decodeURIComponent(new URL(url).pathname.split("/").at(-1) ?? "");
    } catch {
      return "";
    }
  })();
  const name = (label.trim() || fromUrl || "attachment").replace(/[^\w .()-]/g, "_").slice(0, 100);
  return name.trim() || "attachment";
}

/**
 * The uploads a piece of Linear Markdown links to, and the Markdown with each
 * link replaced by a short note such as `[image: screenshot.png]`.
 */
export function takeUploads(markdown: string): {
  readonly text: string;
  readonly uploads: ReadonlyArray<LinearUpload>;
} {
  const uploads = new Map<string, LinearUpload>();
  const note = (image: boolean, label: string, url: string) => {
    const known = uploads.get(url);
    const name = known?.name ?? uploadName(label, url);
    const isImage = image || known?.image === true;
    uploads.set(url, { url, name, ...(isImage ? { image: true } : {}) });
    return `[${isImage ? "image" : "file"}: ${name}]`;
  };
  const text = markdown
    // The whole tag goes, so its JSON (and the link inside) never reaches the agent.
    .replace(IMAGE_TAG, (whole, json: string) => {
      const tag = imageTag(json);
      if (tag === undefined) return whole;
      if (!tag.src.startsWith(`https://${UPLOAD_HOST}/`)) {
        return `[image: ${uploadName(tag.title, tag.src)}]`;
      }
      return note(true, tag.title, tag.src);
    })
    .replace(UPLOAD_LINK, (_whole, bang: string, label: string, url: string) =>
      note(bang === "!", label, url),
    )
    .replace(UPLOAD_URL, (url) => note(false, "", url));
  return { text, uploads: [...uploads.values()] };
}

/** Removes upload links from text that is only shown, such as Linear's context, without collecting them. */
export const withoutUploadLinks = (markdown: string): string => takeUploads(markdown).text;

const HEIC = /\.(heic|heif)$/i;
const HEIC_TYPES = new Set(["image/heic", "image/heif"]);

/** HEIC to JPEG with ffmpeg, as the Mac does with sips for iMessage; models don't read HEIC. */
export async function heicToJpeg(bytes: Uint8Array): Promise<Uint8Array> {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "linear-heic-"));
  try {
    const input = NodePath.join(dir, "in.heic");
    const output = NodePath.join(dir, "out.jpg");
    await NodeFSP.writeFile(input, bytes, { mode: 0o600 });
    await new Promise<void>((resolve, reject) => {
      NodeChildProcess.execFile(
        "ffmpeg",
        ["-hide_banner", "-loglevel", "error", "-i", input, "-frames:v", "1", "-q:v", "3", output],
        { timeout: 60_000 },
        (error) => (error ? reject(error) : resolve()),
      );
    });
    return new Uint8Array(await NodeFSP.readFile(output));
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
}

/** The uploads as the event's files; `downloadUpload` fetches each when T3 imports it. */
export function uploadEventFiles(uploads: ReadonlyArray<LinearUpload>): ReadonlyArray<EventFile> {
  return uploads.map((upload) => {
    if (HEIC.test(upload.name)) {
      return { name: upload.name.replace(HEIC, ".jpg"), mimeType: "image/jpeg", url: upload.url };
    }
    if (upload.image !== true) return { name: upload.name, url: upload.url };
    // An image T3 can show the model; without a known extension, say PNG, as Linear's pastes are.
    const type = IMAGE_TYPES[upload.name.split(".").pop()?.toLowerCase() ?? ""];
    return type === undefined
      ? { name: `${upload.name}.png`, mimeType: "image/png", url: upload.url }
      : { name: upload.name, mimeType: type, url: upload.url };
  });
}

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** Downloads an upload with the bridge's token, sent to Linear's upload host alone; HEIC comes back as JPEG. */
export async function downloadUpload(
  url: string,
  options: {
    /** The bridge's current `Authorization` header for Linear. */
    readonly authorization: () => string;
    readonly convertHeic?: (bytes: Uint8Array) => Promise<Uint8Array>;
  },
): Promise<Uint8Array> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.host !== UPLOAD_HOST) {
    throw new Error("Not a Linear upload.");
  }
  // Fetch drops the header if Linear redirects to another host.
  const response = await fetch(url, { headers: { authorization: options.authorization() } });
  if (!response.ok) throw new Error(`Linear answered ${response.status} for an upload.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const type = (response.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
  const heic = HEIC_TYPES.has(type) || HEIC.test(parsed.pathname);
  return heic ? (options.convertHeic ?? heicToJpeg)(bytes) : bytes;
}
