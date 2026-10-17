import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  copyFile,
  rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, "extension/assets/vendor/ocr");
const work = await mkdtemp(join(tmpdir(), "bntrans-ocr-vendor-"));
const modelCommit = "87416418657359cb625c412a48b6e1d6d41c29bd";
const sources = [
  {
    name: "tesseract",
    url: "https://registry.npmjs.org/tesseract.js/-/tesseract.js-5.1.1.tgz",
    hash: "0d08b3722256aacfc652d03b68183a9ed3c997b54778842e7db73ff08a6ae81a"
  },
  {
    name: "core",
    url: "https://registry.npmjs.org/tesseract.js-core/-/tesseract.js-core-5.1.1.tgz",
    hash: "8c1c83c01ecbfcaeb62a5a2d1023ea98162cad082aa47b9c2c39c129847dba8a"
  },
  {
    name: "eng.traineddata",
    url: `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/${modelCommit}/eng.traineddata`,
    hash: "7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2"
  },
  {
    name: "TESSDATA-LICENSE",
    url: `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/${modelCommit}/LICENSE`,
    hash: "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30"
  }
];

try {
  await readFile(join(root, "package.json"));
  await mkdir(join(target, "core"), { recursive: true });
  await mkdir(join(target, "lang"), { recursive: true });
  for (const source of sources) {
    const response = await fetch(source.url);
    if (!response.ok) throw new Error(`Download failed: ${source.name}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== source.hash) {
      throw new Error(`Integrity mismatch: ${source.name}`);
    }
    const path = join(work, source.name);
    await writeFile(path, bytes);
    if (["tesseract", "core"].includes(source.name)) {
      const dir = join(work, `${source.name}-unpacked`);
      await mkdir(dir);
      execFileSync("tar", ["-xzf", path, "-C", dir]);
    }
  }
  const js = join(work, "tesseract-unpacked/package");
  const core = join(work, "core-unpacked/package");
  await copyFile(join(js, "dist/worker.min.js"), join(target, "worker.min.js"));
  await copyFile(
    join(js, "dist/worker.min.js.LICENSE.txt"),
    join(target, "worker.min.js.LICENSE.txt")
  );
  await copyFile(join(js, "LICENSE.md"), join(target, "TESSERACT-LICENSE.md"));
  await copyFile(join(core, "LICENSE"), join(target, "CORE-LICENSE"));
  await copyFile(
    join(work, "TESSDATA-LICENSE"),
    join(target, "TESSDATA-LICENSE")
  );
  for (const variant of ["", "-simd", "-lstm", "-simd-lstm"]) {
    const name = `tesseract-core${variant}.wasm.js`;
    await copyFile(join(core, name), join(target, "core", name));
  }
  const model = await readFile(join(work, "eng.traineddata"));
  await writeFile(
    join(target, "lang/eng.traineddata.gz"),
    gzipSync(model, { level: 9 })
  );
  console.log(
    "Vendored verified Tesseract.js 5.1.1 + core 5.1.1 + tessdata_fast eng (offline)."
  );
} finally {
  await rm(work, { recursive: true, force: true });
}
