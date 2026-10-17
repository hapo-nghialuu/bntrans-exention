import { cp, mkdir, readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const target = new URL("extension/assets/vendor/", root);
for (const [name, version] of [
  ["pdfjs-dist", "4.10.38"],
  ["fflate", "0.8.3"]
]) {
  const pkg = JSON.parse(
    await readFile(new URL(`node_modules/${name}/package.json`, root))
  );
  if (pkg.version !== version) throw new Error(`Expected ${name}@${version}`);
}
await mkdir(target, { recursive: true });
for (const [source, destination] of [
  ["pdfjs-dist/build/pdf.mjs", "pdfjs/pdf.mjs"],
  ["pdfjs-dist/build/pdf.worker.mjs", "pdfjs/pdf.worker.mjs"],
  ["pdfjs-dist/LICENSE", "pdfjs/LICENSE"],
  ["pdfjs-dist/cmaps", "pdfjs/cmaps"],
  ["pdfjs-dist/standard_fonts", "pdfjs/standard_fonts"],
  ["fflate/esm/browser.js", "fflate/fflate.mjs"],
  ["fflate/LICENSE", "fflate/LICENSE"]
]) {
  const dest = new URL(destination, target);
  await mkdir(new URL("./", dest), { recursive: true });
  await cp(new URL(`node_modules/${source}`, root), dest, { recursive: true });
}
console.log("Vendored pdfjs-dist@4.10.38 + fflate@0.8.3 (including licenses)");
