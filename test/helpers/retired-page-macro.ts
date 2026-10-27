/** macros/page.json exactly as shipped at f438157, before it was retired. */
export const RETIRED_PAGE_JSON = `{
  "defaults": {
    "siteTitle": "rkroll",
    "menu": [
      { "label": "Home", "target": "/" },
      { "label": "About", "target": "/about" }
    ],
    "announcement": { "text": "", "enabled": false },
    "footer": { "links": [], "buttons": [] }
  },
  "fieldSchema": {
    "siteTitle": { "label": "Site title", "type": "text" }
  },
  "tree": {
    "type": "section",
    "slots": { "theme": "light", "edge": "straight" },
    "children": []
  }
}
`;
