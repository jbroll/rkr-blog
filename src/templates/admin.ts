// Admin SPA shell. Serves the mount point and loads the compiled admin
// bundle from /static/admin/main.js. The actual editor wires up in
// src/admin/main.ts.

export interface AdminPageData {
  /** Where the compiled admin bundle is mounted on the URL space. */
  bundleUrl: string;
}

export function renderAdminPage(data: AdminPageData): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>rkroll admin</title>
</head>
<body>
<div id="rkroll-admin-root"></div>
<script type="module" src="${data.bundleUrl}"></script>
</body>
</html>
`;
}
