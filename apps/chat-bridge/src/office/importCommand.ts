import { loadConfig } from "../config.ts";
import { savedToken } from "../login.ts";
import { T3Client } from "../t3Client.ts";
import { importOffice } from "./import.ts";
import { OfficeExportClient } from "./legacy.ts";

export async function runOfficeImport(options: {
  home: string;
  configFile: string;
  dryRun: boolean;
  office: { convexUrl: string; serviceToken: string };
  token?: string | undefined;
  print: (line: string) => void;
}): Promise<void> {
  const config = loadConfig(options.configFile);
  const token = options.token || savedToken(options.home, config.t3Url);
  if (!token)
    throw new Error(`Not signed in to ${config.t3Url}. Run \`t3-chat-bridge login\` first.`);
  const t3 = new T3Client(new URL(config.t3Url), token, config.t3EnvironmentId);
  try {
    const environmentId = await t3.verifyEnvironment();
    options.print(JSON.stringify({ dryRun: options.dryRun, t3Url: config.t3Url, environmentId }));
    const counts = await importOffice({
      home: options.home,
      dryRun: options.dryRun,
      office: new OfficeExportClient(options.office.convexUrl, options.office.serviceToken),
      report: (row) => options.print(JSON.stringify(row)),
    });
    options.print(JSON.stringify({ dryRun: options.dryRun, ...counts }));
  } finally {
    await t3.close();
  }
}
