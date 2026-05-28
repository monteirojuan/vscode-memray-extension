## 2026-05-28 - Cross-Site Scripting (XSS) in HTML Webview
**Vulnerability Pattern:** Unsanitized variables passed directly into `panel.webview.html` via `fs.readFile`.
**Root Cause:** The `memray.openResult` command reads a `.html` artifact directly from the file system (which can be a manipulated workspace file) and assigns it to `panel.webview.html` without enforcing a strict Content Security Policy for the generated HTML. An attacker can craft a malicious `.memray/xxx.html` file that executes arbitrary JavaScript in the VS Code Webview context.
**Prevention Guidance:** All dynamically created Webviews must enforce a strong Content-Security-Policy (CSP) inside the `<meta http-equiv="Content-Security-Policy">` tag. The HTML should not be loaded directly via `fs.readFile` and set as `panel.webview.html` unless it is strictly trusted, or it should be loaded with a strict CSP that limits script execution to trusted URIs (using nonces or hashes).

## 2026-05-28 - Command Injection in pythonDetection.ts
**Vulnerability Pattern:** Unsanitized variables passed directly into `execP` (a wrapper for `child_process.exec`).
**Root Cause:** In `src/utils/pythonDetection.ts`, the `which` function calls `execP("which ${cmd}")`. Although currently the inputs are hardcoded, passing variables into `exec` instead of `spawn` introduces a severe risk of shell command injection if the input ever becomes dynamic or user-controlled.
**Prevention Guidance:** Avoid using `child_process.exec` entirely. Use `child_process.spawn` or `child_process.execFile` or a dedicated library like `which` to prevent shell injection vectors.
