using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

internal static class Launcher
{
    private const string Url = "http://127.0.0.1:7799";

    [STAThread]
    private static void Main()
    {
        var root = AppDomain.CurrentDomain.BaseDirectory;
        var buildId = ReadBuildId(Path.Combine(root, "release.json"));

        if (IsReady())
        {
            var runningBuildId = GetRunningBuildId();
            if (String.Equals(runningBuildId, buildId, StringComparison.Ordinal))
            {
                OpenBrowser();
                return;
            }

            if (!TryShutdownAndWait() && !ConfirmAndStopLegacyServer()) return;
        }

        bool ownsMutex;
        using (var mutex = new Mutex(true, "Gitruck.AIDramaDesk.Launcher." + SafeName(buildId), out ownsMutex))
        {
            if (!ownsMutex)
            {
                WaitUntilReady();
                OpenBrowser();
                return;
            }

            var app = Path.Combine(root, "app");
            var runtime = Path.Combine(root, "runtime", "bun.exe");
            var server = Path.Combine(app, "server.js");
            if (!File.Exists(runtime) || !File.Exists(server))
            {
                MessageBox.Show("安装文件不完整，请重新安装 AI 再现制片工作台。", "Gitruck AI Drama Desk", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            var localData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            var data = Path.Combine(localData, "Gitruck", "AI Drama Desk", "data");
            Directory.CreateDirectory(data);
            var start = new ProcessStartInfo(runtime, Quote(server))
            {
                WorkingDirectory = app,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            start.EnvironmentVariables["GITRUCK_DESK_ROOT"] = app;
            start.EnvironmentVariables["GITRUCK_DESK_DATA_DIR"] = data;
            start.EnvironmentVariables["GITRUCK_DESK_BUILD_ID"] = buildId;
            start.EnvironmentVariables["PATH"] = Path.Combine(root, "tools") + ";" + start.EnvironmentVariables["PATH"];

            using (var child = Process.Start(start))
            {
                for (var i = 0; i < 80 && !child.HasExited; i++)
                {
                    if (IsReady())
                    {
                        OpenBrowser();
                        child.WaitForExit();
                        return;
                    }
                    Thread.Sleep(250);
                }
                MessageBox.Show("工作台未能在 20 秒内启动。请重新运行；若仍失败，请查看用户数据目录中的日志。", "Gitruck AI Drama Desk", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }
    }

    private static string ReadBuildId(string releasePath)
    {
        try
        {
            var match = Regex.Match(File.ReadAllText(releasePath), "\\\"buildId\\\"\\s*:\\s*\\\"([^\\\"]+)\\\"");
            if (match.Success) return match.Groups[1].Value;
        }
        catch { }
        return "unknown-build";
    }

    private static string GetRunningBuildId()
    {
        try
        {
            var request = (HttpWebRequest)WebRequest.Create(Url + "/api/v1/app/identity");
            request.Timeout = 1000;
            request.CachePolicy = new System.Net.Cache.RequestCachePolicy(System.Net.Cache.RequestCacheLevel.NoCacheNoStore);
            using (var response = request.GetResponse())
            using (var reader = new StreamReader(response.GetResponseStream())) return reader.ReadToEnd().Trim();
        }
        catch { return null; }
    }

    private static bool TryShutdownAndWait()
    {
        try
        {
            var request = (HttpWebRequest)WebRequest.Create(Url + "/api/v1/app/shutdown");
            request.Method = "POST";
            request.ContentLength = 0;
            request.Timeout = 1500;
            request.Headers["X-Gitruck-Launcher"] = "1";
            using (request.GetResponse()) { }
            return WaitUntilStopped();
        }
        catch { return false; }
    }

    private static bool ConfirmAndStopLegacyServer()
    {
        var pid = FindListenerPid();
        if (pid <= 0)
        {
            MessageBox.Show("7799 端口正被另一程序占用，无法启动当前版本。请先退出正在运行的旧版工作台。", "Gitruck AI Drama Desk", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return false;
        }

        try
        {
            using (var process = Process.GetProcessById(pid))
            {
                var executable = process.MainModule.FileName;
                if (!String.Equals(Path.GetFileName(executable), "bun.exe", StringComparison.OrdinalIgnoreCase)
                    || executable.IndexOf("Gitruck AI Drama Desk", StringComparison.OrdinalIgnoreCase) < 0)
                {
                    MessageBox.Show("7799 端口正被另一程序占用，无法安全地自动关闭。请先退出占用该端口的程序。", "Gitruck AI Drama Desk", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return false;
                }

                var choice = MessageBox.Show(
                    "检测到旧版工作台仍在后台运行。切换到当前版本会关闭旧版后台；正在执行的生成任务将被中断，但已保存的项目不会丢失。是否继续？",
                    "切换工作台版本",
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Warning);
                if (choice != DialogResult.Yes) return false;
                process.Kill();
                process.WaitForExit(5000);
            }
            return WaitUntilStopped();
        }
        catch
        {
            MessageBox.Show("旧版后台无法自动关闭，请在任务管理器中结束对应的 bun.exe 后重试。", "Gitruck AI Drama Desk", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return false;
        }
    }

    private static int FindListenerPid()
    {
        try
        {
            var start = new ProcessStartInfo("netstat.exe", "-ano -p tcp")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true
            };
            using (var process = Process.Start(start))
            {
                var output = process.StandardOutput.ReadToEnd();
                process.WaitForExit(3000);
                foreach (var line in output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
                {
                    var match = Regex.Match(line, @"^\s*TCP\s+127\.0\.0\.1:7799\s+\S+\s+LISTENING\s+(\d+)\s*$", RegexOptions.IgnoreCase);
                    int pid;
                    if (match.Success && Int32.TryParse(match.Groups[1].Value, out pid)) return pid;
                }
            }
        }
        catch { }
        return 0;
    }

    private static bool WaitUntilStopped()
    {
        for (var i = 0; i < 40; i++)
        {
            if (!IsReady()) return true;
            Thread.Sleep(125);
        }
        return false;
    }

    private static bool WaitUntilReady()
    {
        for (var i = 0; i < 80; i++)
        {
            if (IsReady()) return true;
            Thread.Sleep(250);
        }
        return false;
    }

    private static bool IsReady()
    {
        try
        {
            var request = (HttpWebRequest)WebRequest.Create(Url + "/api/v1/projects");
            request.Timeout = 500;
            using (var response = (HttpWebResponse)request.GetResponse()) return response.StatusCode == HttpStatusCode.OK;
        }
        catch { return false; }
    }

    private static void OpenBrowser()
    {
        Process.Start(new ProcessStartInfo(Url) { UseShellExecute = true });
    }

    private static string SafeName(string value) { return Regex.Replace(value ?? "unknown", "[^A-Za-z0-9_.-]", "_"); }
    private static string Quote(string value) { return "\"" + value.Replace("\"", "\\\"") + "\""; }
}
