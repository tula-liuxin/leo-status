import React from 'react'

// Lucide SVG paths: https://github.com/lucide-icons/lucide (ISC + Feather MIT).
// bold: lucide-static 0.468.0. Other paths: official main, retrieved 2026-10-28.
// enter: original leo-status paper-and-arrow drawing on the same 24 px grid.
// trashX/trashSweep: original leo-status bin-cross and broom drawings, same grid/stroke.
// top/arrowUpToLine: official Lucide icons/arrow-up-to-line.svg.
// React and native Tiptap NodeViews intentionally share these path definitions.
const paths = {
  "folderMove": [["path",{"d":"M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"}],["path",{"d":"M9 13h7m-3-3 3 3-3 3"}]],
  "trashX": [
    ["path", {"d":"M3 6h18M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"}],
    ["path", {"d":"m5 6 1 14a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1l1-14"}],
    ["path", {"d":"m9 11 6 6m0-6-6 6"}]
  ],
  "trashSweep": [
    ["path", {"d":"m17 3-7 9"}],
    ["path", {"d":"m7 11 6 4-4 6H3l-1-4 5-6Z"}],
    ["path", {"d":"m6 16-2 4m5-2-2 3M13 21h8"}]
  ],
  "refresh": [
    [
      "path",
      {
        "d": "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"
      }
    ],
    [
      "path",
      {
        "d": "M21 3v5h-5"
      }
    ],
    [
      "path",
      {
        "d": "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"
      }
    ],
    [
      "path",
      {
        "d": "M8 16H3v5"
      }
    ]
  ],
  "x": [
    [
      "path",
      {
        "d": "M18 6 6 18"
      }
    ],
    [
      "path",
      {
        "d": "m6 6 12 12"
      }
    ]
  ],
  "chevronRight": [
    [
      "path",
      {
        "d": "m9 18 6-6-6-6"
      }
    ]
  ],
  "chevronDown": [
    [
      "path",
      {
        "d": "m6 9 6 6 6-6"
      }
    ]
  ],
  "indent": [
    [
      "path",
      {
        "d": "M21 5H11"
      }
    ],
    [
      "path",
      {
        "d": "M21 12H11"
      }
    ],
    [
      "path",
      {
        "d": "M21 19H11"
      }
    ],
    [
      "path",
      {
        "d": "m3 8 4 4-4 4"
      }
    ]
  ],
  "outdent": [
    [
      "path",
      {
        "d": "M21 5H11"
      }
    ],
    [
      "path",
      {
        "d": "M21 12H11"
      }
    ],
    [
      "path",
      {
        "d": "M21 19H11"
      }
    ],
    [
      "path",
      {
        "d": "m7 8-4 4 4 4"
      }
    ]
  ],
  "link": [
    [
      "path",
      {
        "d": "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"
      }
    ],
    [
      "path",
      {
        "d": "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"
      }
    ]
  ],
  "paperclip": [
    [
      "path",
      {
        "d": "m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551"
      }
    ]
  ],
  "mic": [
    [
      "path",
      {
        "d": "M12 19v3"
      }
    ],
    [
      "path",
      {
        "d": "M19 10v2a7 7 0 0 1-14 0v-2"
      }
    ],
    [
      "rect",
      {
        "x": "9",
        "y": "2",
        "width": "6",
        "height": "13",
        "rx": "3"
      }
    ]
  ],
  "stop": [
    [
      "rect",
      {
        "width": "18",
        "height": "18",
        "x": "3",
        "y": "3",
        "rx": "2"
      }
    ]
  ],
  "todo": [
    [
      "path",
      {
        "d": "M13 5h8"
      }
    ],
    [
      "path",
      {
        "d": "M13 12h8"
      }
    ],
    [
      "path",
      {
        "d": "M13 19h8"
      }
    ],
    [
      "path",
      {
        "d": "m3 17 2 2 4-4"
      }
    ],
    [
      "path",
      {
        "d": "m3 7 2 2 4-4"
      }
    ]
  ],
  "timeline": [
    [
      "path",
      {
        "d": "M12 3v6"
      }
    ],
    [
      "circle",
      {
        "cx": "12",
        "cy": "12",
        "r": "3"
      }
    ],
    [
      "path",
      {
        "d": "M12 15v6"
      }
    ]
  ],
  "trash": [
    [
      "path",
      {
        "d": "M10 11v6"
      }
    ],
    [
      "path",
      {
        "d": "M14 11v6"
      }
    ],
    [
      "path",
      {
        "d": "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"
      }
    ],
    [
      "path",
      {
        "d": "M3 6h18"
      }
    ],
    [
      "path",
      {
        "d": "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"
      }
    ]
  ],
  "undo": [
    [
      "path",
      {
        "d": "M9 14 4 9l5-5"
      }
    ],
    [
      "path",
      {
        "d": "M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"
      }
    ]
  ],
  "redo": [
    [
      "path",
      {
        "d": "m15 14 5-5-5-5"
      }
    ],
    [
      "path",
      {
        "d": "M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13"
      }
    ]
  ],
  "more": [
    [
      "circle",
      {
        "cx": "12",
        "cy": "12",
        "r": "1"
      }
    ],
    [
      "circle",
      {
        "cx": "19",
        "cy": "12",
        "r": "1"
      }
    ],
    [
      "circle",
      {
        "cx": "5",
        "cy": "12",
        "r": "1"
      }
    ]
  ],
  "bold": [
    [
      "path",
      {
        "d": "M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8"
      }
    ]
  ],
  "italic": [
    [
      "line",
      {
        "x1": "19",
        "x2": "10",
        "y1": "4",
        "y2": "4"
      }
    ],
    [
      "line",
      {
        "x1": "14",
        "x2": "5",
        "y1": "20",
        "y2": "20"
      }
    ],
    [
      "line",
      {
        "x1": "15",
        "x2": "9",
        "y1": "4",
        "y2": "20"
      }
    ]
  ],
  "heading": [
    [
      "path",
      {
        "d": "M4 12h8"
      }
    ],
    [
      "path",
      {
        "d": "M4 18V6"
      }
    ],
    [
      "path",
      {
        "d": "M12 18V6"
      }
    ],
    [
      "path",
      {
        "d": "M21 18h-4c0-4 4-3 4-6 0-1.5-2-2.5-4-1"
      }
    ]
  ],
  "list": [
    [
      "path",
      {
        "d": "M3 5h.01"
      }
    ],
    [
      "path",
      {
        "d": "M3 12h.01"
      }
    ],
    [
      "path",
      {
        "d": "M3 19h.01"
      }
    ],
    [
      "path",
      {
        "d": "M8 5h13"
      }
    ],
    [
      "path",
      {
        "d": "M8 12h13"
      }
    ],
    [
      "path",
      {
        "d": "M8 19h13"
      }
    ]
  ],
  "plus": [
    [
      "path",
      {
        "d": "M5 12h14"
      }
    ],
    [
      "path",
      {
        "d": "M12 5v14"
      }
    ]
  ],
  "minus": [
    [
      "path",
      {
        "d": "M5 12h14"
      }
    ]
  ],
  "calendar": [
    [
      "path",
      {
        "d": "M8 2v3"
      }
    ],
    [
      "path",
      {
        "d": "M16 2v3"
      }
    ],
    [
      "rect",
      {
        "x": "3",
        "y": "3",
        "width": "18",
        "height": "18",
        "rx": "2"
      }
    ],
    [
      "path",
      {
        "d": "M3 9h18"
      }
    ]
  ],
  "restore": [
    [
      "path",
      {
        "d": "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"
      }
    ],
    [
      "path",
      {
        "d": "M3 3v5h5"
      }
    ]
  ],
  "external": [
    [
      "path",
      {
        "d": "M15 3h6v6"
      }
    ],
    [
      "path",
      {
        "d": "M10 14 21 3"
      }
    ],
    [
      "path",
      {
        "d": "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"
      }
    ]
  ],
  "unlink": [
    [
      "path",
      {
        "d": "m18.84 12.25 1.72-1.71h-.02a5.004 5.004 0 0 0-.12-7.07 5.006 5.006 0 0 0-6.95 0l-1.72 1.71"
      }
    ],
    [
      "path",
      {
        "d": "m5.17 11.75-1.71 1.71a5.004 5.004 0 0 0 .12 7.07 5.006 5.006 0 0 0 6.95 0l1.71-1.71"
      }
    ],
    [
      "line",
      {
        "x1": "8",
        "x2": "8",
        "y1": "2",
        "y2": "5"
      }
    ],
    [
      "line",
      {
        "x1": "2",
        "x2": "5",
        "y1": "8",
        "y2": "8"
      }
    ],
    [
      "line",
      {
        "x1": "16",
        "x2": "16",
        "y1": "19",
        "y2": "22"
      }
    ],
    [
      "line",
      {
        "x1": "19",
        "x2": "22",
        "y1": "16",
        "y2": "16"
      }
    ]
  ],
  "search": [
    [
      "path",
      {
        "d": "m21 21-4.34-4.34"
      }
    ],
    [
      "circle",
      {
        "cx": "11",
        "cy": "11",
        "r": "8"
      }
    ]
  ],
  "enter": [
    [
      "path",
      {
        "d": "M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h7"
      }
    ],
    [
      "path",
      {
        "d": "M13 3v5h5M13 3l5 5v3"
      }
    ],
    [
      "path",
      {
        "d": "M12 16h9m-3-3 3 3-3 3"
      }
    ]
  ],
  "top": [
    [
      "path",
      {
        "d": "M5 3h14"
      }
    ],
    [
      "path",
      {
        "d": "m18 13-6-6-6 6"
      }
    ],
    [
      "path",
      {
        "d": "M12 7v14"
      }
    ]
  ],
  "ban": [
    ["circle", { "cx": "12", "cy": "12", "r": "10" }],
    ["path", { "d": "m4.9 4.9 14.2 14.2" }]
  ],
  "checkCircle": [
    ["circle", { "cx": "12", "cy": "12", "r": "10" }],
    ["path", { "d": "m9 12 2 2 4-4" }]
  ],
  "arrowUpToLine": [
    [
      "path",
      {
        "d": "M5 3h14"
      }
    ],
    [
      "path",
      {
        "d": "m18 13-6-6-6 6"
      }
    ],
    [
      "path",
      {
        "d": "M12 7v14"
      }
    ]
  ]
}

export const iconNames = Object.freeze(Object.keys(paths))
const attributes = {viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.8,strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true,focusable:false}
const camel = key => key.replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase())
export function Icon({name,size=18,className='',...props}) {
 const nodes=paths[name] || paths.more
 return React.createElement('svg',{...attributes,width:size,height:size,...props,className:('ln-icon '+className).trim()},nodes.map(([tag,attrs],index)=>React.createElement(tag,{key:index,...Object.fromEntries(Object.entries(attrs).map(([k,v])=>[camel(k),v]))})))
}
export function createIcon(name,size=18) {
 const svg=document.createElementNS('http://www.w3.org/2000/svg','svg')
 for(const [key,value] of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':1.8,'stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true',focusable:'false',width:size,height:size,class:'ln-icon'})) svg.setAttribute(key,String(value))
 for(const [tag,attrs] of paths[name] || paths.more){const element=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [key,value] of Object.entries(attrs))element.setAttribute(key,value);svg.append(element)}
 return svg
}
