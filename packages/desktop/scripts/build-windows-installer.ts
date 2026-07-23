import { spawnSync } from "node:child_process";
import { existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const PROJECT_DIR = join(import.meta.dir, "..");
const RELEASE_DIR = join(PROJECT_DIR, "release");
const IS_DEV = process.argv.includes("--dev");

const installerName = IS_DEV ? "orchidea-desktop-dev-x64.exe" : "orchidea-desktop-x64.exe";
const zipName = IS_DEV ? "orchidea-desktop-dev-x64.zip" : "orchidea-desktop-x64.zip";
const installerBlockmapName = `${installerName}.blockmap`;

const WINDOWS_STALE_ARTIFACTS = [
  join(RELEASE_DIR, installerName),
  join(RELEASE_DIR, installerBlockmapName),
  join(RELEASE_DIR, installerName.replace(/\.exe$/, ".__uninstaller.exe")),
];

function removeStaleInstallerArtifacts(): void {
  for (const filePath of WINDOWS_STALE_ARTIFACTS) {
    if (existsSync(filePath)) {
      try {
        statSync(filePath);
        rmSync(filePath, { force: true });
      } catch {
        // file may be broken/0-byte from a previous failed build
        rmSync(filePath, { force: true });
      }
    }
  }
}

function isNativeWindows(): boolean {
  return process.platform === "win32";
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

function runBuilder(buildEnv: NodeJS.ProcessEnv): boolean {
  const builderArgs = [
    "x",
    "electron-builder",
    "--win",
    "--x64",
    "--config",
    "configs/electron-builder.mjs",
  ];
  if (IS_DEV) {
    builderArgs.push("--publish=never");
  }

  const result = spawnSync(process.execPath, builderArgs, {
    cwd: PROJECT_DIR,
    stdio: "inherit",
    env: buildEnv,
  });
  return result.status === 0;
}

function verifyInstaller(): boolean {
  const installerPath = join(RELEASE_DIR, installerName);
  if (!existsSync(installerPath)) return false;

  const MINIMUM_EXPECTED_BYTES = 10 * 1024 * 1024;
  try {
    if (statSync(installerPath).size < MINIMUM_EXPECTED_BYTES) {
      removeStaleInstallerArtifacts();
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function verifyZip(): boolean {
  const zipPath = join(RELEASE_DIR, zipName);
  if (!existsSync(zipPath)) return false;

  const MINIMUM_EXPECTED_BYTES = 10 * 1024 * 1024;
  try {
    return statSync(zipPath).size >= MINIMUM_EXPECTED_BYTES;
  } catch {
    return false;
  }
}

function main(): void {
  const buildEnv = IS_DEV ? { ...process.env, BUILD_ENV: "dev" } : process.env;

  removeStaleInstallerArtifacts();

  // Step 1: build the app
  console.log("\n[1/2] Building app...");
  const buildResult = spawnSync(process.execPath, ["run", "build"], {
    cwd: PROJECT_DIR,
    stdio: "inherit",
    env: buildEnv,
  });
  if (buildResult.status !== 0) {
    throw new Error("App build failed");
  }

  // Step 2: package for Windows (nsis + zip)
  console.log("\n[2/2] Packaging for Windows...");
  if (!isNativeWindows()) {
    console.warn("⚠ 交叉构建：macOS 上的 NSIS 安装器生成不稳定，会尝试但 zip 兜底。");
    console.warn("  如需可靠的 .exe 安装器，请在 Windows 上运行或使用 CI 工作流。\n");
  }

  const builderOk = runBuilder(buildEnv);

  // Step 3: verify outputs
  const hasInstaller = verifyInstaller();
  const hasZip = verifyZip();

  if (hasInstaller) {
    const size = formatBytes(statSync(join(RELEASE_DIR, installerName)).size);
    console.log(`\n✓ Windows 安装器: release/${installerName} (${size})`);
  }

  if (hasZip) {
    const size = formatBytes(statSync(join(RELEASE_DIR, zipName)).size);
    console.log(`✓ Windows 便携包:  release/${zipName} (${size})`);
  }

  if (!hasZip) {
    removeStaleInstallerArtifacts();
    throw new Error("Windows 打包完全失败：既没有生成安装器，也没有生成便携包。");
  }

  if (!hasInstaller) {
    console.warn("\n⚠ NSIS 安装器未能生成（macOS 交叉构建的已知限制）。");
    console.warn("  .zip 便携包可以直接在 Windows 上解压运行。");
    console.warn("  要获取 .exe 安装器，请:");
    console.warn("  - 在 Windows 机器上运行 bun run build:win");
    console.warn("  - 或触发 .github/workflows/publish-windows.yml\n");
    // Exit 0 — zip is a valid deliverable
    return;
  }

  if (!builderOk) {
    // Builder reported failure but installer exists and is valid — odd but ok
    console.warn("\n⚠ electron-builder 报告了错误，但安装器已成功生成。");
  }
}

main();
