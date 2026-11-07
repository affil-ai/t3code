// affil-imessage: runs `imsg rpc` for the chat bridge and serves it on one TCP port.
// It is the process macOS grants Full Disk Access and Automation to, so `imsg`, its
// child, inherits them, and it can read incoming attachments for the bridge.
//
// Protocol: newline-delimited JSON-RPC 2.0, as `imsg rpc` speaks it, limited to the
// methods the bridge needs. The service watches every chat itself from the moment
// `imsg` starts, and sends each new message to the connected client as a `message`
// notification; a client catches up on what it missed with `messages.after`.
// `attachment.read` and `attachment.write` are answered here:
// {"path": "<original_path from imsg>"} -> {"data": base64, "bytes": n}, and
// {"name", "data": base64} -> {"path"}, a file `send` can then take as `file`.
// One client at a time; a new connection replaces the old one.
//
// Build: swiftc -O -o affil-imessage affil-imessage.swift
// Run:   affil-imessage --imsg <path to imsg> [--host 127.0.0.1] [--port 47821]

import Foundation
import Network

let maxAttachmentBytes = 100 * 1024 * 1024
/// What the bridge may call. Everything else, such as deleting chats, is refused.
let allowedMethods: Set<String> = [
  "initialize", "status", "chats.list", "chats.get", "messages.history", "messages.after",
  "send", "send.attachment", "tapback", "attachment.read", "attachment.write",
]
/// The id of the service's own watch request; its reply stays here.
let watchRequestId = "affil-imessage:watch"

func log(_ line: String) {
  FileHandle.standardError.write(Data("\(ISO8601DateFormatter().string(from: Date())) \(line)\n".utf8))
}

var arguments = [String: String]()
var argumentIndex = 1
while argumentIndex + 1 < CommandLine.arguments.count {
  arguments[CommandLine.arguments[argumentIndex]] = CommandLine.arguments[argumentIndex + 1]
  argumentIndex += 2
}
guard let imsgPath = arguments["--imsg"] else {
  log("usage: affil-imessage --imsg <path> [--host 127.0.0.1] [--port 47821]")
  exit(2)
}
let host = arguments["--host"] ?? "127.0.0.1"
let port = NWEndpoint.Port(rawValue: UInt16(arguments["--port"] ?? "47821") ?? 47821)!
let attachmentsRoot = URL(fileURLWithPath: NSHomeDirectory())
  .appendingPathComponent("Library/Messages/Attachments").resolvingSymlinksInPath().path + "/"

let queue = DispatchQueue(label: "affil-imessage")
var client: NWConnection?
var imsgInput: FileHandle?
var clientBuffer = Data()
var imsgBuffer = Data()


// MARK: - Plumbing

func json(_ line: Data) -> [String: Any]? {
  try? JSONSerialization.jsonObject(with: line) as? [String: Any]
}

func encode(_ object: [String: Any]) -> Data? {
  try? JSONSerialization.data(withJSONObject: object)
}

func sendToClient(_ line: Data) {
  guard let connection = client else { return }
  var framed = line
  framed.append(0x0A)
  connection.send(content: framed, completion: .contentProcessed { _ in })
}

func reply(id: Any?, result: [String: Any]? = nil, error: (Int, String)? = nil) {
  var message: [String: Any] = ["jsonrpc": "2.0", "id": id ?? NSNull()]
  if let result { message["result"] = result }
  if let error { message["error"] = ["code": error.0, "message": error.1] }
  if let data = encode(message) { sendToClient(data) }
}

/// Splits `buffer` into complete lines and hands each to `handle`.
func drainLines(_ buffer: inout Data, _ handle: (Data) -> Void) {
  while let newline = buffer.firstIndex(of: 0x0A) {
    let line = buffer.subdata(in: buffer.startIndex..<newline)
    buffer.removeSubrange(buffer.startIndex...newline)
    if !line.isEmpty { handle(line) }
  }
}

// MARK: - Client to imsg

/// HEIC photos as JPEG, which models read; `sips` ships with macOS.
func jpegCopy(of path: String) -> Data? {
  let out = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).jpg")
  defer { try? FileManager.default.removeItem(at: out) }
  let sips = Process()
  sips.executableURL = URL(fileURLWithPath: "/usr/bin/sips")
  sips.arguments = ["-s", "format", "jpeg", path, "--out", out.path]
  sips.standardOutput = FileHandle.nullDevice
  sips.standardError = FileHandle.nullDevice
  guard (try? sips.run()) != nil else { return nil }
  sips.waitUntilExit()
  return sips.terminationStatus == 0 ? FileManager.default.contents(atPath: out.path) : nil
}

func readAttachment(id: Any?, params: [String: Any]?) {
  let jpeg = params?["jpeg"] as? Bool == true
  guard let path = params?["path"] as? String, (params?.count ?? 0) == (params?["jpeg"] == nil ? 1 : 2)
  else {
    return reply(id: id, error: (-32602, "attachment.read takes a path, and optionally jpeg."))
  }
  let resolved = URL(fileURLWithPath: path).resolvingSymlinksInPath().path
  guard resolved.hasPrefix(attachmentsRoot) else {
    return reply(id: id, error: (-32602, "The path is not under the Messages attachments folder."))
  }
  guard let attributes = try? FileManager.default.attributesOfItem(atPath: resolved),
    let size = attributes[.size] as? Int
  else { return reply(id: id, error: (-32603, "The attachment can't be read.")) }
  guard size <= maxAttachmentBytes else {
    return reply(id: id, error: (-32602, "The attachment is over \(maxAttachmentBytes) bytes."))
  }
  guard let data = jpeg ? jpegCopy(of: resolved) : FileManager.default.contents(atPath: resolved)
  else {
    return reply(id: id, error: (-32603, "The attachment can't be read."))
  }
  reply(id: id, result: ["data": data.base64EncodedString(), "bytes": data.count])
}

/// Saves an outgoing file under the Messages attachments folder, where Messages can read it.
func writeAttachment(id: Any?, params: [String: Any]?) {
  guard let name = params?["name"] as? String, let base64 = params?["data"] as? String,
    params?.count == 2, let data = Data(base64Encoded: base64)
  else { return reply(id: id, error: (-32602, "attachment.write takes a name and base64 data.")) }
  guard data.count <= maxAttachmentBytes else {
    return reply(id: id, error: (-32602, "The attachment is over \(maxAttachmentBytes) bytes."))
  }
  let safeName = String(name.map { "/:\\".contains($0) ? "_" : $0 }.prefix(120))
  let folder = URL(fileURLWithPath: attachmentsRoot)
    .appendingPathComponent("affil-imessage/\(UUID().uuidString)")
  let file = folder.appendingPathComponent(safeName.isEmpty || safeName.hasPrefix(".") ? "file" : safeName)
  do {
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    try data.write(to: file)
  } catch {
    return reply(id: id, error: (-32603, "The attachment can't be saved."))
  }
  reply(id: id, result: ["path": file.path])
}

func handleClientLine(_ line: Data) {
  guard let request = json(line), let method = request["method"] as? String else {
    return reply(id: nil, error: (-32600, "Invalid request."))
  }
  let id = request["id"]
  guard allowedMethods.contains(method) else {
    return reply(id: id, error: (-32601, "\(method) is not available through affil-imessage."))
  }
  if method == "attachment.read" {
    return readAttachment(id: id, params: request["params"] as? [String: Any])
  }
  if method == "attachment.write" {
    return writeAttachment(id: id, params: request["params"] as? [String: Any])
  }
  guard let input = imsgInput else {
    return reply(id: id, error: (-32603, "imsg is restarting; try again."))
  }
  var framed = line
  framed.append(0x0A)
  input.write(framed)
}

// MARK: - Processes and connections

/// Watches every chat from the current tail, with attachments and tapbacks.
func subscribe() {
  guard let input = imsgInput else { return }
  let request: [String: Any] = [
    "jsonrpc": "2.0", "id": watchRequestId, "method": "watch.subscribe",
    "params": ["attachments": true, "include_reactions": true, "buffer_limit": 4096],
  ]
  guard var line = try? JSONSerialization.data(withJSONObject: request) else { return }
  line.append(0x0A)
  input.write(line)
}

/// Keeps the service's own watch going and passes everything else to the client.
func handleImsgLine(_ line: Data) {
  if let message = json(line) {
    if message["id"] as? String == watchRequestId {
      if let error = message["error"] {
        log("Watching failed: \(error); trying again in 5 s.")
        queue.asyncAfter(deadline: .now() + 5) { subscribe() }
      } else {
        log("Watching all chats.")
      }
      return
    }
    if message["method"] as? String == "watch.overflow" {
      log("The watch fell behind; subscribing again. The client catches up with messages.after.")
      return subscribe()
    }
  }
  sendToClient(line)
}

func startImsg() {
  let process = Process()
  process.executableURL = URL(fileURLWithPath: imsgPath)
  process.arguments = ["rpc"]
  let stdin = Pipe()
  let stdout = Pipe()
  process.standardInput = stdin
  process.standardOutput = stdout
  process.standardError = FileHandle.standardError
  stdout.fileHandleForReading.readabilityHandler = { handle in
    let chunk = handle.availableData
    queue.async {
      imsgBuffer.append(chunk)
      drainLines(&imsgBuffer, handleImsgLine)
    }
  }
  process.terminationHandler = { finished in
    queue.async {
      log("imsg exited with status \(finished.terminationStatus); restarting in 5 s.")
      imsgInput = nil
      queue.asyncAfter(deadline: .now() + 5) { startImsg() }
    }
  }
  do {
    try process.run()
    imsgInput = stdin.fileHandleForWriting
    log("Started imsg rpc (pid \(process.processIdentifier)).")
    subscribe()
  } catch {
    log("Starting imsg failed: \(error); retrying in 5 s.")
    queue.asyncAfter(deadline: .now() + 5) { startImsg() }
  }
}

func receive(on connection: NWConnection) {
  connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { data, _, done, error in
    guard connection === client else { return }
    if let data {
      clientBuffer.append(data)
      drainLines(&clientBuffer, handleClientLine)
    }
    if done || error != nil {
      log("Client disconnected.")
      connection.cancel()
      client = nil
      return
    }
    receive(on: connection)
  }
}

let parameters = NWParameters.tcp
parameters.requiredLocalEndpoint = .hostPort(host: NWEndpoint.Host(host), port: port)
let listener = try NWListener(using: parameters)
listener.newConnectionHandler = { connection in
  queue.async {
    client?.cancel()
    client = connection
    clientBuffer = Data()
    log("Client connected.")
    connection.start(queue: queue)
    receive(on: connection)
  }
}
listener.stateUpdateHandler = { state in log("Listener \(host):\(port): \(state)") }
queue.async { startImsg() }
listener.start(queue: queue)
dispatchMain()
