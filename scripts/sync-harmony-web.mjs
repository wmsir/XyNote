import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const targetDir = path.join(
  rootDir,
  "harmony-pc",
  "entry",
  "src",
  "main",
  "resources",
  "rawfile",
  "web"
);

if (!fs.existsSync(distDir)) {
  console.error("[sync-harmony-web] dist/ 不存在，请先执行 npm run build");
  process.exit(1);
}

fs.rmSync(targetDir, { recursive: true, force: true });
fs.mkdirSync(targetDir, { recursive: true });
fs.cpSync(distDir, targetDir, { recursive: true });

// 同步版本号到 harmony-pc/AppScope/app.json5
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
const ver = String(pkg.version || "0.8.10");
const [maj = 0, min = 8, pat = 10] = ver.split(".").map((n) => parseInt(n, 10) || 0);
const versionCode = maj * 1000000 + min * 1000 + pat;
const appJson5Path = path.join(rootDir, "harmony-pc", "AppScope", "app.json5");
if (fs.existsSync(appJson5Path)) {
  let txt = fs.readFileSync(appJson5Path, "utf8");
  txt = txt.replace(/"versionCode"\s*:\s*\d+/, `"versionCode": ${versionCode}`);
  txt = txt.replace(/"versionName"\s*:\s*"[^"]+"/, `"versionName": "${ver}"`);
  fs.writeFileSync(appJson5Path, txt, "utf8");
}

console.log(`[sync-harmony-web] 已同步 dist/ -> ${path.relative(rootDir, targetDir)} (v${ver}, code=${versionCode})`);
