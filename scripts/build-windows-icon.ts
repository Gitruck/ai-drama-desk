import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import sharp from "sharp";

const [sourceArg, destinationArg] = Bun.argv.slice(2);

if (!sourceArg || !destinationArg) {
  throw new Error("用法：bun scripts/build-windows-icon.ts <logo.svg> <launcher.ico>");
}

const source = resolve(sourceArg);
const destination = resolve(destinationArg);
const png = await sharp(source)
  .resize(256, 256, { fit: "contain" })
  .png()
  .toBuffer();

// ICO 容器可以直接承载一张 256×256 PNG。0 宽高在目录项中代表 256。
const header = Buffer.alloc(22);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // image type: icon
header.writeUInt16LE(1, 4); // image count
header.writeUInt8(0, 6); // width: 256
header.writeUInt8(0, 7); // height: 256
header.writeUInt8(0, 8); // palette
header.writeUInt8(0, 9); // reserved
header.writeUInt16LE(1, 10); // color planes
header.writeUInt16LE(32, 12); // bits per pixel
header.writeUInt32LE(png.length, 14);
header.writeUInt32LE(header.length, 18);

await mkdir(dirname(destination), { recursive: true });
await Bun.write(destination, Buffer.concat([header, png]));
