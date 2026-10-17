import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const liveTests = new Set(["test-screenshot-e2e.mjs"]);
const tests = readdirSync(join(root, "scripts"))
  .filter((name) => /^test-.+\.mjs$/.test(name) && !liveTests.has(name))
  .sort()
  .map((name) => join(root, "scripts", name));
if (!tests.length) throw new Error("Không tìm thấy automated unit tests");
console.log(
  `Chạy ${tests.length} tập unit/regression; live screenshot e2e cần credentials riêng.`
);
const result = spawnSync(process.execPath, ["--test", ...tests], {
  cwd: root,
  stdio: "inherit"
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
