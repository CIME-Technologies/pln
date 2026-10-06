// Dev-only: renders the webview markup outside VS Code so the UI can be eyeballed.
const fs = require("fs");
const path = require("path");
const esbuild = require("esbuild");

const root = path.join(__dirname, "..");
const outDir = path.join(root, ".preview");
const planFile = process.argv[2] || path.join(root, "examples", "product-launch.pln");

fs.mkdirSync(outDir, { recursive: true });

esbuild.buildSync({
  entryPoints: [path.join(root, "src", "planModel.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: path.join(outDir, "planModel.js"),
});

const { parsePlan } = require(path.join(outDir, "planModel.js"));

const source = fs.readFileSync(path.join(root, "src", "planEditorProvider.ts"), "utf8");
const match = source.match(/return `(<!DOCTYPE html>[\s\S]*?<\/html>)`;/);
if (!match) {
  throw new Error("Could not extract webview HTML template");
}

const plan = parsePlan(
  fs.readFileSync(planFile, "utf8"),
  path.basename(planFile, path.extname(planFile))
);

const bodyClass = process.argv.includes("--light") ? "vscode-light" : "vscode-dark";
const showHover = process.argv.includes("--hover");
const openMenu = process.argv.includes("--menu");

const debug = `
  ${showHover ? ".icon-btn { opacity: 1 !important; } .group-ratio { opacity: 1 !important; }" : ""}
`;

const html = match[1]
  .replace("<body>", `<body class="${bodyClass}">`)
  .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "")
  .replace(/\$\{styleUri\}/g, "../media/planEditor.css")
  .replace(/\$\{scriptUri\}/g, "../media/planEditor.js")
  .replace(/ nonce="\$\{nonce\}"/g, "")
  .replace(
    "</head>",
    `<script>
      window.acquireVsCodeApi = () => ({
        postMessage: (m) => {
          if (m.type === "ready") {
            window.postMessage({ type: "update", plan: ${JSON.stringify(plan)} }, "*");
          }
        },
        getState: () => ({}),
        setState: () => {},
      });
      ${
        openMenu
          ? `window.addEventListener("load", () => setTimeout(() => {
               const rows = document.querySelectorAll(".row .icon-btn");
               if (rows[1]) rows[1].click();
             }, 60));`
          : ""
      }
      ${
        process.argv.includes("--edit")
          ? `window.addEventListener("load", () => setTimeout(() => {
               const t = document.querySelectorAll(".row-title");
               if (t[1]) t[1].click();
             }, 60));`
          : ""
      }
    </script>
    <style>${debug}</style>
    </head>`
  );

const target = path.join(outDir, "index.html");
fs.writeFileSync(target, html);
console.log(target);
