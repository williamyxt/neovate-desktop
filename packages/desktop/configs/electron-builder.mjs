const isDev = process.env.BUILD_ENV === "dev";

/**
 * @type {import('electron-builder').Configuration}
 * @see https://www.electron.build/configuration
 */
/** @param {import('electron-builder').BeforePackContext} context */
async function beforePack(context) {
  const { execSync } = await import("node:child_process");
  const { existsSync } = await import("node:fs");
  const path = await import("node:path");

  const projectDir = context.packager.projectDir;

  // electron-builder Arch enum: 0=ia32, 1=x64, 2=armv7l, 3=arm64, 4=universal
  const archMap = { 1: "x64", 3: "arm64" };
  const arch = archMap[context.arch];
  if (!arch) throw new Error(`Unsupported arch: ${context.arch}`);

  // Map electron-builder platform name to Node.js process.platform values
  const platformNameMap = { mac: "darwin", linux: "linux", windows: "win32" };
  const platform =
    platformNameMap[context.packager.platform.name] || context.packager.platform.name;
  const isWin = platform === "win32";
  const binExt = isWin ? ".exe" : "";

  const bunBin = path.join(projectDir, "vendor", "bun", `bun${binExt}`);
  if (!existsSync(bunBin)) {
    console.log(`  • downloading bun for ${platform}/${arch}...`);
    execSync(`bun scripts/download-bun.ts --platform ${platform} --arch ${arch}`, {
      cwd: projectDir,
      stdio: "inherit",
    });
  }

  const rtkBin = path.join(projectDir, "vendor", "rtk", `rtk${binExt}`);
  if (!existsSync(rtkBin)) {
    console.log(`  • downloading rtk for ${platform}/${arch}...`);
    execSync(`bun scripts/download-rtk.ts --platform ${platform} --arch ${arch}`, {
      cwd: projectDir,
      stdio: "inherit",
    });
  }

  if (platform === "darwin") {
    const helperSource = path.join(
      projectDir,
      "resources",
      "computer-control",
      "macos-helper.swift",
    );
    const helperBinary = path.join(
      projectDir,
      "resources",
      "computer-control",
      "orchidea-computer-control-helper",
    );
    if (existsSync(helperSource)) {
      console.log("  • compiling macOS computer-control helper...");
      execSync(
        `/usr/bin/xcrun swiftc -O "${helperSource}" -framework AppKit -framework ApplicationServices -o "${helperBinary}"`,
        {
          cwd: projectDir,
          stdio: "inherit",
        },
      );
    }
  }
}

/** @param {import('electron-builder').AfterPackContext} context */
async function afterPack(context) {
  const fs = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  const path = await import("node:path");

  if (context.packager.platform.name !== "mac") return;

  const usage = "用于语音对话与会议录音/转写。";

  const escapeXml = (s) =>
    String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

  const ensurePlistKey = (xml, key, value) => {
    if (xml.includes(`<key>${key}</key>`)) return xml;
    const insert = `  <key>${key}</key>\n  <string>${escapeXml(value)}</string>\n`;
    const idx = xml.lastIndexOf("</dict>");
    if (idx < 0) return xml;
    return `${xml.slice(0, idx)}${insert}${xml.slice(idx)}`;
  };

  const outDir = context.appOutDir;
  const entries = await fs.readdir(outDir);
  const appName = entries.find((e) => e.endsWith(".app"));
  if (!appName) return;
  const appPath = path.join(outDir, appName);
  const frameworksDir = path.join(appPath, "Contents", "Frameworks");
  if (!existsSync(frameworksDir)) return;

  const frameworks = await fs.readdir(frameworksDir);
  const helperApps = frameworks.filter((e) => e.endsWith(".app"));

  for (const helper of helperApps) {
    const plistPath = path.join(frameworksDir, helper, "Contents", "Info.plist");
    if (!existsSync(plistPath)) continue;
    const xml = await fs.readFile(plistPath, "utf-8");
    const next = ensurePlistKey(xml, "NSMicrophoneUsageDescription", usage);
    if (next !== xml) await fs.writeFile(plistPath, next);
  }
}

const config = {
  appId: isDev ? "com.orchidea.desktop.dev" : "com.orchidea.desktop",
  productName: isDev ? "Orchidea Desktop Dev" : "Orchidea Desktop",

  directories: {
    buildResources: "build",
    output: "release",
  },

  artifactName: isDev ? "orchidea-desktop-dev-${arch}.${ext}" : "orchidea-desktop-${arch}.${ext}",

  asar: true,
  asarUnpack: [
    "**/node_modules/node-pty/**/*",
    "**/node_modules/@anthropic-ai/claude-agent-sdk/**/*",
  ],

  beforePack,
  afterPack,

  extraResources: [
    { from: "vendor/bun", to: "bun", filter: ["bun", "bun.exe"] },
    { from: "vendor/rtk", to: "rtk", filter: ["rtk", "rtk.exe"] },
    { from: "resources/fetch-interceptor.js", to: "fetch-interceptor.js" },
    { from: "resources/html-anything", to: "html-anything" },
    {
      from: "resources/orchidea-voice",
      to: "orchidea-voice",
      filter: ["**/*", "!models/**"],
    },
    { from: "resources/computer-control", to: "computer-control" },
  ],

  files: [
    {
      from: ".",
      filter: [
        "package.json",
        "dist/**/*",
        "node_modules/**/*",
        "!resources/**",
        "!**/.vscode/*",
        "!src/*",
        "!electron.vite.config.{js,ts,mjs,cjs}",
        "!{.eslintcache,eslint.config.mjs,.prettierignore,.prettierrc.yaml,dev-app-update.yml,CHANGELOG.md,README.md}",
        "!{.env,.env.*,.npmrc,pnpm-lock.yaml}",
        "!{tsconfig.json,tsconfig.node.json,tsconfig.web.json}",
      ],
    },
  ],

  protocols: [{ name: "Orchidea Desktop", schemes: [isDev ? "orchidea-dev" : "orchidea"] }],

  compression: isDev ? "normal" : "maximum",

  mac: {
    icon: isDev ? "build/icons/dev/icon.icns" : "build/icons/prod/icon.icns",
    category: "public.app-category.developer-tools",
    hardenedRuntime: true,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.plist",
    target: ["dmg", "zip"],
    notarize: !!(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD),
    extendInfo: {
      NSMicrophoneUsageDescription: "用于语音对话与会议录音/转写。",
      NSAppleEventsUsageDescription: "用于控制桌面应用、窗口聚焦与键鼠自动化。",
      NSBluetoothAlwaysUsageDescription: "用于通过蓝牙连接录音笔并采集音频。",
      NSBluetoothPeripheralUsageDescription: "用于通过蓝牙连接录音笔并采集音频。",
    },
    files: [
      "!**/node_modules/@anthropic-ai/claude-agent-sdk/vendor/ripgrep/*-linux/**",
      "!**/node_modules/@anthropic-ai/claude-agent-sdk/vendor/ripgrep/*-win32/**",
      "!**/node_modules/node-pty/prebuilds/win32-*/**",
      "!**/node_modules/node-pty/prebuilds/linux-*/**",
    ],
  },

  win: {
    icon: isDev ? "build/icons/dev/icon.png" : "build/icons/prod/icon.png",
    target: [
      { target: "nsis", arch: ["x64"] },
      { target: "zip", arch: ["x64"] },
    ],
    files: [
      "!**/node_modules/@anthropic-ai/claude-agent-sdk/vendor/ripgrep/*-linux/**",
      "!**/node_modules/@anthropic-ai/claude-agent-sdk/vendor/ripgrep/*-darwin/**",
      "!**/node_modules/node-pty/prebuilds/darwin-*/**",
      "!**/node_modules/node-pty/prebuilds/linux-*/**",
    ],
  },

  linux: {
    icon: isDev ? "build/icons/dev" : "build/icons/prod",
    category: "Development",
    target: [{ target: "AppImage", arch: ["x64"] }],
    files: [
      "!**/node_modules/@anthropic-ai/claude-agent-sdk/vendor/ripgrep/*-darwin/**",
      "!**/node_modules/@anthropic-ai/claude-agent-sdk/vendor/ripgrep/*-win32/**",
      "!**/node_modules/node-pty/prebuilds/darwin-*/**",
      "!**/node_modules/node-pty/prebuilds/win32-*/**",
    ],
  },

  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
  },

  npmRebuild: false,

  electronLanguages: ["en", "en-US", "en-GB"],
};

export default config;
