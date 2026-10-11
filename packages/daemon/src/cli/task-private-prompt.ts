/** Hidden owner input from the controlling terminal, never argv/env/stdin. */
import { openSync } from "node:fs";
import { ReadStream, WriteStream } from "node:tty";
export async function taskPrivatePrompt(label: string, passphrase = false): Promise<string> {
  const fd = openSync("/dev/tty", "r+");
  const input = new ReadStream(fd); const output = new WriteStream(openSync("/dev/tty", "w"));
  output.write(label); input.setRawMode(true); input.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      input.setRawMode(false); input.pause(); output.end("\n"); input.destroy();
      if (error) reject(error); else resolve(value);
    };
    input.on("data", (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\u0003" || char === "\u0004") { finish(new Error("Owner input cancelled")); return; }
        if (char === "\r" || char === "\n") { finish(); return; }
        if (char === "\u007f") value = value.slice(0, -1);
        else if ((passphrase ? !/[\p{Cc}\p{Cf}]/u.test(char) : /^[A-Za-z0-9_-]$/.test(char)) && value.length < 1024) value += char;
      }
    });
    input.on("error", finish);
  });
}
