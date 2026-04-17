import * as vscode from 'vscode';

export class DashboardPanel implements vscode.Disposable {
  private static instance: DashboardPanel | undefined;
  private readonly panel: vscode.WebviewPanel;

  private constructor(private readonly port: number) {
    this.panel = vscode.window.createWebviewPanel(
      'mcpDashboard',
      'MCP Agent Chat',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );

    this.panel.webview.html = this.buildHtml();
    this.panel.onDidDispose(() => {
      DashboardPanel.instance = undefined;
    });
  }

  static show(port: number): void {
    if (DashboardPanel.instance) {
      DashboardPanel.instance.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }
    DashboardPanel.instance = new DashboardPanel(port);
  }

  private buildHtml(): string {
    const dashboardUrl = `http://localhost:${this.port}`;
    // CSP relaxed for localhost iframe
    return /* html */ `<!DOCTYPE html>
<html lang="en" style="height:100%;margin:0;padding:0;">
<head>
  <meta charset="UTF-8"/>
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'self' http://localhost:${this.port};
                 frame-src http://localhost:${this.port};
                 script-src 'self' 'unsafe-inline';
                 style-src 'self' 'unsafe-inline';" />
  <style>
    html, body, iframe { height: 100%; width: 100%; margin: 0; padding: 0; border: none; }
  </style>
</head>
<body>
  <iframe src="${dashboardUrl}" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>
</body>
</html>`;
  }

  dispose(): void {
    this.panel.dispose();
    DashboardPanel.instance = undefined;
  }
}
