🔒 Fix potential command injection in which function

🎯 **What:**
Fixed a potential command injection vulnerability in the `which` function located in `src/utils/pythonDetection.ts`.

⚠️ **Risk:**
The `which` function previously used `exec` with direct string interpolation (`which ${cmd}`). If the `cmd` argument ever originated from untrusted user input, an attacker could inject arbitrary shell commands, leading to remote code execution (RCE) or other severe security breaches.

🛡️ **Solution:**
Replaced the `child_process.exec` function with `child_process.execFile`. By passing the arguments as an array instead of concatenating them into a single shell command string, `execFile` executes the target binary directly without invoking a shell. This completely eliminates the shell interpolation vulnerability while preserving the original functionality.
