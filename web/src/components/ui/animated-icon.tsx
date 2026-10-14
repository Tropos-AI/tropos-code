// Animated icon from 000h by Cojeev — MIT licence — docs, variants and the full library: https://cojeev.com/ui/docs/animated-icon/
// Adapted for Tropos Code (web/src/components/ui/animated-icon.tsx): no "use client", the 000h stylesheet is trimmed
// to the icon rules and moved to animated-icon.css (mapped onto our tokens, no remote fonts), StateChevron uses the
// lazy `m` component, and the inner static Icon is exported as CojeevIcon for the <Icon> wrapper.

import * as React from "react";
import { useSyncExternalStore } from "react";
import { type ClassValue, clsx } from "clsx";
import { animate, type AnimationPlaybackControls, frameSteps, motionValue, type Transition } from "motion";
import { m } from "motion/react";
import "./animated-icon.css";
import { twMerge } from "tailwind-merge";

// ---- registry/cojeev/lib/utils.ts (inlined) ----
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ---- registry/cojeev/lib/icon-data.ts (inlined) ----
// Geometry from the authored icon sprite. No browser sprite injection is required.
/*
Additional geometry from installed lucide-react 0.577.0.
ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2026 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2026.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

---

The MIT License (MIT) (for portions derived from Feather)

Copyright (c) 2013-2026 Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
const iconData: Record<string, IconNode[]> = {"activity":[{"tag":"path","attrs":{"d":"M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"},"children":[]}],"arrow-down-right":[{"tag":"path","attrs":{"d":"m7 7 10 10"},"children":[]},{"tag":"path","attrs":{"d":"M17 7v10H7"},"children":[]}],"arrow-left":[{"tag":"path","attrs":{"d":"m12 19-7-7 7-7"},"children":[]},{"tag":"path","attrs":{"d":"M19 12H5"},"children":[]}],"arrow-right":[{"tag":"path","attrs":{"d":"M5 12h14"},"children":[]},{"tag":"path","attrs":{"d":"m12 5 7 7-7 7"},"children":[]}],"arrow-up-down":[{"tag":"path","attrs":{"d":"m21 16-4 4-4-4"},"children":[]},{"tag":"path","attrs":{"d":"M17 20V4"},"children":[]},{"tag":"path","attrs":{"d":"m3 8 4-4 4 4"},"children":[]},{"tag":"path","attrs":{"d":"M7 4v16"},"children":[]}],"arrow-up-right":[{"tag":"path","attrs":{"d":"M7 7h10v10"},"children":[]},{"tag":"path","attrs":{"d":"M7 17 17 7"},"children":[]}],"at-sign":[{"tag":"circle","attrs":{"cx":"12","cy":"12","r":"4"},"children":[]},{"tag":"path","attrs":{"d":"M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"},"children":[]}],"bell-dot":[{"tag":"path","attrs":{"d":"M10.268 21a2 2 0 0 0 3.464 0"},"children":[]},{"tag":"path","attrs":{"d":"M11.68 2.009A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673c-.824-.85-1.678-1.731-2.21-3.348"},"children":[]},{"tag":"circle","attrs":{"cx":"18","cy":"5","r":"3"},"children":[]}],"bell":[{"tag":"path","attrs":{"d":"M10.268 21a2 2 0 0 0 3.464 0"},"children":[]},{"tag":"path","attrs":{"d":"M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"},"children":[]}],"bookmark":[{"tag":"path","attrs":{"d":"M17 3a2 2 0 0 1 2 2v15a1 1 0 0 1-1.496.868l-4.512-2.578a2 2 0 0 0-1.984 0l-4.512 2.578A1 1 0 0 1 5 20V5a2 2 0 0 1 2-2z"},"children":[]}],"bot":[{"tag":"path","attrs":{"d":"M12 8V4H8"},"children":[]},{"tag":"rect","attrs":{"width":"16","height":"12","x":"4","y":"8","rx":"2"},"children":[]},{"tag":"path","attrs":{"d":"M2 14h2"},"children":[]},{"tag":"path","attrs":{"d":"M20 14h2"},"children":[]},{"tag":"path","attrs":{"d":"M15 13v2"},"children":[]},{"tag":"path","attrs":{"d":"M9 13v2"},"children":[]}],"brain":[{"tag":"path","attrs":{"d":"M12 18V5"},"children":[]},{"tag":"path","attrs":{"d":"M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4"},"children":[]},{"tag":"path","attrs":{"d":"M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5"},"children":[]},{"tag":"path","attrs":{"d":"M17.997 5.125a4 4 0 0 1 2.526 5.77"},"children":[]},{"tag":"path","attrs":{"d":"M18 18a4 4 0 0 0 2-7.464"},"children":[]},{"tag":"path","attrs":{"d":"M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517"},"children":[]},{"tag":"path","attrs":{"d":"M6 18a4 4 0 0 1-2-7.464"},"children":[]},{"tag":"path","attrs":{"d":"M6.003 5.125a4 4 0 0 0-2.526 5.77"},"children":[]}],"calendar-clock":[{"tag":"path","attrs":{"d":"M16 14v2.2l1.6 1"},"children":[]},{"tag":"path","attrs":{"d":"M16 2v4"},"children":[]},{"tag":"path","attrs":{"d":"M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5"},"children":[]},{"tag":"path","attrs":{"d":"M3 10h5"},"children":[]},{"tag":"path","attrs":{"d":"M8 2v4"},"children":[]},{"tag":"circle","attrs":{"cx":"16","cy":"16","r":"6"},"children":[]}],"calendar-days":[{"tag":"path","attrs":{"d":"M8 2v4"},"children":[]},{"tag":"path","attrs":{"d":"M16 2v4"},"children":[]},{"tag":"rect","attrs":{"width":"18","height":"18","x":"3","y":"4","rx":"2"},"children":[]},{"tag":"path","attrs":{"d":"M3 10h18"},"children":[]},{"tag":"path","attrs":{"d":"M8 14h.01"},"children":[]},{"tag":"path","attrs":{"d":"M12 14h.01"},"children":[]},{"tag":"path","attrs":{"d":"M16 14h.01"},"children":[]},{"tag":"path","attrs":{"d":"M8 18h.01"},"children":[]},{"tag":"path","attrs":{"d":"M12 18h.01"},"children":[]},{"tag":"path","attrs":{"d":"M16 18h.01"},"children":[]}],"calendar":[{"tag":"path","attrs":{"d":"M8 2v4"},"children":[]},{"tag":"path","attrs":{"d":"M16 2v4"},"children":[]},{"tag":"rect","attrs":{"width":"18","height":"18","x":"3","y":"4","rx":"2"},"children":[]},{"tag":"path","attrs":{"d":"M3 10h18"},"children":[]}],"check":[{"tag":"path","attrs":{"d":"M20 6 9 17l-5-5"},"children":[]}],"chevron-down":[{"tag":"path","attrs":{"d":"m6 9 6 6 6-6"},"children":[]}],"chevron-left":[{"tag":"path","attrs":{"d":"m15 18-6-6 6-6"},"children":[]}],"chevron-right":[{"tag":"path","attrs":{"d":"m9 18 6-6-6-6"},"children":[]}],"chevron-up":[{"tag":"path","attrs":{"d":"m18 15-6-6-6 6"},"children":[]}],"circle-alert":[{"tag":"circle","attrs":{"cx":"12","cy":"12","r":"10"},"children":[]},{"tag":"line","attrs":{"x1":"12","x2":"12","y1":"8","y2":"12"},"children":[]},{"tag":"line","attrs":{"x1":"12","x2":"12.01","y1":"16","y2":"16"},"children":[]}],"circle-check-big":[{"tag":"path","attrs":{"d":"M21.801 10A10 10 0 1 1 17 3.335"},"children":[]},{"tag":"path","attrs":{"d":"m9 11 3 3L22 4"},"children":[]}],"circle-check":[{"tag":"circle","attrs":{"cx":"12","cy":"12","r":"10"},"children":[]},{"tag":"path","attrs":{"d":"m9 12 2 2 4-4"},"children":[]}],"circle-plus":[{"tag":"circle","attrs":{"cx":"12","cy":"12","r":"10"},"children":[]},{"tag":"path","attrs":{"d":"M8 12h8"},"children":[]},{"tag":"path","attrs":{"d":"M12 8v8"},"children":[]}],"circle":[{"tag":"circle","attrs":{"cx":"12","cy":"12","r":"10"},"children":[]}],"clock":[{"tag":"circle","attrs":{"cx":"12","cy":"12","r":"10"},"children":[]},{"tag":"path","attrs":{"d":"M12 6v6l4 2"},"children":[]}],"copy":[{"tag":"rect","attrs":{"width":"14","height":"14","x":"8","y":"8","rx":"2","ry":"2"},"children":[]},{"tag":"path","attrs":{"d":"M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"},"children":[]}],"cpu":[{"tag":"path","attrs":{"d":"M12 20v2"},"children":[]},{"tag":"path","attrs":{"d":"M12 2v2"},"children":[]},{"tag":"path","attrs":{"d":"M17 20v2"},"children":[]},{"tag":"path","attrs":{"d":"M17 2v2"},"children":[]},{"tag":"path","attrs":{"d":"M2 12h2"},"children":[]},{"tag":"path","attrs":{"d":"M2 17h2"},"children":[]},{"tag":"path","attrs":{"d":"M2 7h2"},"children":[]},{"tag":"path","attrs":{"d":"M20 12h2"},"children":[]},{"tag":"path","attrs":{"d":"M20 17h2"},"children":[]},{"tag":"path","attrs":{"d":"M20 7h2"},"children":[]},{"tag":"path","attrs":{"d":"M7 20v2"},"children":[]},{"tag":"path","attrs":{"d":"M7 2v2"},"children":[]},{"tag":"rect","attrs":{"x":"4","y":"4","width":"16","height":"16","rx":"2"},"children":[]},{"tag":"rect","attrs":{"x":"8","y":"8","width":"8","height":"8","rx":"1"},"children":[]}],"crosshair":[{"tag":"circle","attrs":{"cx":"12","cy":"12","r":"10"},"children":[]},{"tag":"line","attrs":{"x1":"22","x2":"18","y1":"12","y2":"12"},"children":[]},{"tag":"line","attrs":{"x1":"6","x2":"2","y1":"12","y2":"12"},"children":[]},{"tag":"line","attrs":{"x1":"12","x2":"12","y1":"6","y2":"2"},"children":[]},{"tag":"line","attrs":{"x1":"12","x2":"12","y1":"22","y2":"18"},"children":[]}],"database":[{"tag":"ellipse","attrs":{"cx":"12","cy":"5","rx":"9","ry":"3"},"children":[]},{"tag":"path","attrs":{"d":"M3 5V19A9 3 0 0 0 21 19V5"},"children":[]},{"tag":"path","attrs":{"d":"M3 12A9 3 0 0 0 21 12"},"children":[]}],"dot":[{"tag":"circle","attrs":{"cx":"12","cy":"12","r":"1"},"children":[]}],"download":[{"tag":"path","attrs":{"d":"M12 15V3"},"children":[]},{"tag":"path","attrs":{"d":"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"},"children":[]},{"tag":"path","attrs":{"d":"m7 10 5 5 5-5"},"children":[]}],"ellipsis-vertical":[{"tag":"circle","attrs":{"cx":"12","cy":"12","r":"1"},"children":[]},{"tag":"circle","attrs":{"cx":"12","cy":"5","r":"1"},"children":[]},{"tag":"circle","attrs":{"cx":"12","cy":"19","r":"1"},"children":[]}],"ellipsis":[{"tag":"circle","attrs":{"cx":"12","cy":"12","r":"1"},"children":[]},{"tag":"circle","attrs":{"cx":"19","cy":"12","r":"1"},"children":[]},{"tag":"circle","attrs":{"cx":"5","cy":"12","r":"1"},"children":[]}],"external-link":[{"tag":"path","attrs":{"d":"M15 3h6v6"},"children":[]},{"tag":"path","attrs":{"d":"M10 14 21 3"},"children":[]},{"tag":"path","attrs":{"d":"M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"},"children":[]}],"eye-off":[{"tag":"path","attrs":{"d":"M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"},"children":[]},{"tag":"path","attrs":{"d":"M14.084 14.158a3 3 0 0 1-4.242-4.242"},"children":[]},{"tag":"path","attrs":{"d":"M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"},"children":[]},{"tag":"path","attrs":{"d":"m2 2 20 20"},"children":[]}],"eye":[{"tag":"path","attrs":{"d":"M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"},"children":[]},{"tag":"circle","attrs":{"cx":"12","cy":"12","r":"3"},"children":[]}],"file-code":[{"tag":"path","attrs":{"d":"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"},"children":[]},{"tag":"path","attrs":{"d":"M14 2v5a1 1 0 0 0 1 1h5"},"children":[]},{"tag":"path","attrs":{"d":"M10 12.5 8 15l2 2.5"},"children":[]},{"tag":"path","attrs":{"d":"m14 12.5 2 2.5-2 2.5"},"children":[]}],"file-text":[{"tag":"path","attrs":{"d":"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"},"children":[]},{"tag":"path","attrs":{"d":"M14 2v5a1 1 0 0 0 1 1h5"},"children":[]},{"tag":"path","attrs":{"d":"M10 9H8"},"children":[]},{"tag":"path","attrs":{"d":"M16 13H8"},"children":[]},{"tag":"path","attrs":{"d":"M16 17H8"},"children":[]}],"flag":[{"tag":"path","attrs":{"d":"M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528"},"children":[]}],"folder":[{"tag":"path","attrs":{"d":"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"},"children":[]}],"funnel":[{"tag":"path","attrs":{"d":"M10 20a1 1 0 0 0 .553.895l2 1A1 1 0 0 0 14 21v-7a2 2 0 0 1 .517-1.341L21.74 4.67A1 1 0 0 0 21 3H3a1 1 0 0 0-.742 1.67l7.225 7.989A2 2 0 0 1 10 14z"},"children":[]}],"gauge":[{"tag":"path","attrs":{"d":"m12 14 4-4"},"children":[]},{"tag":"path","attrs":{"d":"M3.34 19a10 10 0 1 1 17.32 0"},"children":[]}],"git-branch":[{"tag":"path","attrs":{"d":"M15 6a9 9 0 0 0-9 9V3"},"children":[]},{"tag":"circle","attrs":{"cx":"18","cy":"6","r":"3"},"children":[]},{"tag":"circle","attrs":{"cx":"6","cy":"18","r":"3"},"children":[]}],"grip-vertical":[{"tag":"circle","attrs":{"cx":"9","cy":"12","r":"1"},"children":[]},{"tag":"circle","attrs":{"cx":"9","cy":"5","r":"1"},"children":[]},{"tag":"circle","attrs":{"cx":"9","cy":"19","r":"1"},"children":[]},{"tag":"circle","attrs":{"cx":"15","cy":"12","r":"1"},"children":[]},{"tag":"circle","attrs":{"cx":"15","cy":"5","r":"1"},"children":[]},{"tag":"circle","attrs":{"cx":"15","cy":"19","r":"1"},"children":[]}],"hash":[{"tag":"line","attrs":{"x1":"4","x2":"20","y1":"9","y2":"9"},"children":[]},{"tag":"line","attrs":{"x1":"4","x2":"20","y1":"15","y2":"15"},"children":[]},{"tag":"line","attrs":{"x1":"10","x2":"8","y1":"3","y2":"21"},"children":[]},{"tag":"line","attrs":{"x1":"16","x2":"14","y1":"3","y2":"21"},"children":[]}],"heart-pulse":[{"tag":"path","attrs":{"d":"M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5"},"children":[]},{"tag":"path","attrs":{"d":"M3.22 13H9.5l.5-1 2 4.5 2-7 1.5 3.5h5.27"},"children":[]}],"house":[{"tag":"path","attrs":{"d":"M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"},"children":[]},{"tag":"path","attrs":{"d":"M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"},"children":[]}],"inbox":[{"tag":"polyline","attrs":{"points":"22 12 16 12 14 15 10 15 8 12 2 12"},"children":[]},{"tag":"path","attrs":{"d":"M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"},"children":[]}],"info":[{"tag":"circle","attrs":{"cx":"12","cy":"12","r":"10"},"children":[]},{"tag":"path","attrs":{"d":"M12 16v-4"},"children":[]},{"tag":"path","attrs":{"d":"M12 8h.01"},"children":[]}],"layout-dashboard":[{"tag":"rect","attrs":{"width":"7","height":"9","x":"3","y":"3","rx":"1"},"children":[]},{"tag":"rect","attrs":{"width":"7","height":"5","x":"14","y":"3","rx":"1"},"children":[]},{"tag":"rect","attrs":{"width":"7","height":"9","x":"14","y":"12","rx":"1"},"children":[]},{"tag":"rect","attrs":{"width":"7","height":"5","x":"3","y":"16","rx":"1"},"children":[]}],"layout-grid":[{"tag":"rect","attrs":{"width":"7","height":"7","x":"3","y":"3","rx":"1"},"children":[]},{"tag":"rect","attrs":{"width":"7","height":"7","x":"14","y":"3","rx":"1"},"children":[]},{"tag":"rect","attrs":{"width":"7","height":"7","x":"14","y":"14","rx":"1"},"children":[]},{"tag":"rect","attrs":{"width":"7","height":"7","x":"3","y":"14","rx":"1"},"children":[]}],"leaf":[{"tag":"path","attrs":{"d":"M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"},"children":[]},{"tag":"path","attrs":{"d":"M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"},"children":[]}],"list":[{"tag":"path","attrs":{"d":"M3 5h.01"},"children":[]},{"tag":"path","attrs":{"d":"M3 12h.01"},"children":[]},{"tag":"path","attrs":{"d":"M3 19h.01"},"children":[]},{"tag":"path","attrs":{"d":"M8 5h13"},"children":[]},{"tag":"path","attrs":{"d":"M8 12h13"},"children":[]},{"tag":"path","attrs":{"d":"M8 19h13"},"children":[]}],"loader-circle":[{"tag":"path","attrs":{"d":"M21 12a9 9 0 1 1-6.219-8.56"},"children":[]}],"lock":[{"tag":"rect","attrs":{"width":"18","height":"11","x":"3","y":"11","rx":"2","ry":"2"},"children":[]},{"tag":"path","attrs":{"d":"M7 11V7a5 5 0 0 1 10 0v4"},"children":[]}],"log-out":[{"tag":"path","attrs":{"d":"m16 17 5-5-5-5"},"children":[]},{"tag":"path","attrs":{"d":"M21 12H9"},"children":[]},{"tag":"path","attrs":{"d":"M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"},"children":[]}],"maximize-2":[{"tag":"path","attrs":{"d":"M15 3h6v6"},"children":[]},{"tag":"path","attrs":{"d":"m21 3-7 7"},"children":[]},{"tag":"path","attrs":{"d":"m3 21 7-7"},"children":[]},{"tag":"path","attrs":{"d":"M9 21H3v-6"},"children":[]}],"message-circle":[{"tag":"path","attrs":{"d":"M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"},"children":[]}],"message-square":[{"tag":"path","attrs":{"d":"M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"},"children":[]}],"minus":[{"tag":"path","attrs":{"d":"M5 12h14"},"children":[]}],"monitor":[{"tag":"rect","attrs":{"width":"20","height":"14","x":"2","y":"3","rx":"2"},"children":[]},{"tag":"line","attrs":{"x1":"8","x2":"16","y1":"21","y2":"21"},"children":[]},{"tag":"line","attrs":{"x1":"12","x2":"12","y1":"17","y2":"21"},"children":[]}],"moon":[{"tag":"path","attrs":{"d":"M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"},"children":[]}],"mouse-pointer-2":[{"tag":"path","attrs":{"d":"M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z"},"children":[]}],"network":[{"tag":"rect","attrs":{"x":"16","y":"16","width":"6","height":"6","rx":"1"},"children":[]},{"tag":"rect","attrs":{"x":"2","y":"16","width":"6","height":"6","rx":"1"},"children":[]},{"tag":"rect","attrs":{"x":"9","y":"2","width":"6","height":"6","rx":"1"},"children":[]},{"tag":"path","attrs":{"d":"M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"},"children":[]},{"tag":"path","attrs":{"d":"M12 12V8"},"children":[]}],"panel-left":[{"tag":"rect","attrs":{"width":"18","height":"18","x":"3","y":"3","rx":"2"},"children":[]},{"tag":"path","attrs":{"d":"M9 3v18"},"children":[]}],"pause":[{"tag":"rect","attrs":{"x":"14","y":"3","width":"5","height":"18","rx":"1"},"children":[]},{"tag":"rect","attrs":{"x":"5","y":"3","width":"5","height":"18","rx":"1"},"children":[]}],"pencil":[{"tag":"path","attrs":{"d":"M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"},"children":[]},{"tag":"path","attrs":{"d":"m15 5 4 4"},"children":[]}],"pin":[{"tag":"path","attrs":{"d":"M12 17v5"},"children":[]},{"tag":"path","attrs":{"d":"M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"},"children":[]}],"play":[{"tag":"path","attrs":{"d":"M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"},"children":[]}],"plus":[{"tag":"path","attrs":{"d":"M5 12h14"},"children":[]},{"tag":"path","attrs":{"d":"M12 5v14"},"children":[]}],"power":[{"tag":"path","attrs":{"d":"M12 2v10"},"children":[]},{"tag":"path","attrs":{"d":"M18.4 6.6a9 9 0 1 1-12.77.04"},"children":[]}],"refresh-cw":[{"tag":"path","attrs":{"d":"M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"},"children":[]},{"tag":"path","attrs":{"d":"M21 3v5h-5"},"children":[]},{"tag":"path","attrs":{"d":"M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"},"children":[]},{"tag":"path","attrs":{"d":"M8 16H3v5"},"children":[]}],"repeat":[{"tag":"path","attrs":{"d":"m17 2 4 4-4 4"},"children":[]},{"tag":"path","attrs":{"d":"M3 11v-1a4 4 0 0 1 4-4h14"},"children":[]},{"tag":"path","attrs":{"d":"m7 22-4-4 4-4"},"children":[]},{"tag":"path","attrs":{"d":"M21 13v1a4 4 0 0 1-4 4H3"},"children":[]}],"search":[{"tag":"path","attrs":{"d":"m21 21-4.34-4.34"},"children":[]},{"tag":"circle","attrs":{"cx":"11","cy":"11","r":"8"},"children":[]}],"send":[{"tag":"path","attrs":{"d":"M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"},"children":[]},{"tag":"path","attrs":{"d":"m21.854 2.147-10.94 10.939"},"children":[]}],"settings":[{"tag":"path","attrs":{"d":"M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"},"children":[]},{"tag":"circle","attrs":{"cx":"12","cy":"12","r":"3"},"children":[]}],"shield":[{"tag":"path","attrs":{"d":"M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"},"children":[]}],"sliders-horizontal":[{"tag":"path","attrs":{"d":"M10 5H3"},"children":[]},{"tag":"path","attrs":{"d":"M12 19H3"},"children":[]},{"tag":"path","attrs":{"d":"M14 3v4"},"children":[]},{"tag":"path","attrs":{"d":"M16 17v4"},"children":[]},{"tag":"path","attrs":{"d":"M21 12h-9"},"children":[]},{"tag":"path","attrs":{"d":"M21 19h-5"},"children":[]},{"tag":"path","attrs":{"d":"M21 5h-7"},"children":[]},{"tag":"path","attrs":{"d":"M8 10v4"},"children":[]},{"tag":"path","attrs":{"d":"M8 12H3"},"children":[]}],"sparkles":[{"tag":"path","attrs":{"d":"M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"},"children":[]},{"tag":"path","attrs":{"d":"M20 2v4"},"children":[]},{"tag":"path","attrs":{"d":"M22 4h-4"},"children":[]},{"tag":"circle","attrs":{"cx":"4","cy":"20","r":"2"},"children":[]}],"square-check":[{"tag":"rect","attrs":{"width":"18","height":"18","x":"3","y":"3","rx":"2"},"children":[]},{"tag":"path","attrs":{"d":"m9 12 2 2 4-4"},"children":[]}],"star":[{"tag":"path","attrs":{"d":"M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"},"children":[]}],"sun":[{"tag":"circle","attrs":{"cx":"12","cy":"12","r":"4"},"children":[]},{"tag":"path","attrs":{"d":"M12 2v2"},"children":[]},{"tag":"path","attrs":{"d":"M12 20v2"},"children":[]},{"tag":"path","attrs":{"d":"m4.93 4.93 1.41 1.41"},"children":[]},{"tag":"path","attrs":{"d":"m17.66 17.66 1.41 1.41"},"children":[]},{"tag":"path","attrs":{"d":"M2 12h2"},"children":[]},{"tag":"path","attrs":{"d":"M20 12h2"},"children":[]},{"tag":"path","attrs":{"d":"m6.34 17.66-1.41 1.41"},"children":[]},{"tag":"path","attrs":{"d":"m19.07 4.93-1.41 1.41"},"children":[]}],"tag":[{"tag":"path","attrs":{"d":"M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"},"children":[]},{"tag":"circle","attrs":{"cx":"7.5","cy":"7.5","r":".5","fill":"currentColor"},"children":[]}],"terminal":[{"tag":"path","attrs":{"d":"M12 19h8"},"children":[]},{"tag":"path","attrs":{"d":"m4 17 6-6-6-6"},"children":[]}],"thumbs-up":[{"tag":"path","attrs":{"d":"M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"},"children":[]},{"tag":"path","attrs":{"d":"M7 10v12"},"children":[]}],"trash-2":[{"tag":"path","attrs":{"d":"M10 11v6"},"children":[]},{"tag":"path","attrs":{"d":"M14 11v6"},"children":[]},{"tag":"path","attrs":{"d":"M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"},"children":[]},{"tag":"path","attrs":{"d":"M3 6h18"},"children":[]},{"tag":"path","attrs":{"d":"M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"},"children":[]}],"trending-down":[{"tag":"path","attrs":{"d":"M16 17h6v-6"},"children":[]},{"tag":"path","attrs":{"d":"m22 17-8.5-8.5-5 5L2 7"},"children":[]}],"trending-up":[{"tag":"path","attrs":{"d":"M16 7h6v6"},"children":[]},{"tag":"path","attrs":{"d":"m22 7-8.5 8.5-5-5L2 17"},"children":[]}],"triangle-alert":[{"tag":"path","attrs":{"d":"m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"},"children":[]},{"tag":"path","attrs":{"d":"M12 9v4"},"children":[]},{"tag":"path","attrs":{"d":"M12 17h.01"},"children":[]}],"upload":[{"tag":"path","attrs":{"d":"M12 3v12"},"children":[]},{"tag":"path","attrs":{"d":"m17 8-5-5-5 5"},"children":[]},{"tag":"path","attrs":{"d":"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"},"children":[]}],"user":[{"tag":"path","attrs":{"d":"M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"},"children":[]},{"tag":"circle","attrs":{"cx":"12","cy":"7","r":"4"},"children":[]}],"users":[{"tag":"path","attrs":{"d":"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"},"children":[]},{"tag":"path","attrs":{"d":"M16 3.128a4 4 0 0 1 0 7.744"},"children":[]},{"tag":"path","attrs":{"d":"M22 21v-2a4 4 0 0 0-3-3.87"},"children":[]},{"tag":"circle","attrs":{"cx":"9","cy":"7","r":"4"},"children":[]}],"workflow":[{"tag":"rect","attrs":{"width":"8","height":"8","x":"3","y":"3","rx":"2"},"children":[]},{"tag":"path","attrs":{"d":"M7 11v4a2 2 0 0 0 2 2h4"},"children":[]},{"tag":"rect","attrs":{"width":"8","height":"8","x":"13","y":"13","rx":"2"},"children":[]}],"x":[{"tag":"path","attrs":{"d":"M18 6 6 18"},"children":[]},{"tag":"path","attrs":{"d":"m6 6 12 12"},"children":[]}],"zap":[{"tag":"path","attrs":{"d":"M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"},"children":[]}],"heart":[{"tag":"path","attrs":{"d":"M19 14c1.5-1.5 3-3.2 3-5.5A4.5 4.5 0 0 0 12 6a4.5 4.5 0 0 0-10 2.5C2 10.8 3.5 12.5 5 14l7 7Z"},"children":[]}],"arrow-r":[{"tag":"path","attrs":{"d":"M5 12h14M13 6l6 6-6 6"},"children":[]}],"arrow-l":[{"tag":"path","attrs":{"d":"M19 12H5M11 18l-6-6 6-6"},"children":[]}],"arrow-ur":[{"tag":"path","attrs":{"d":"M7 17 17 7M8 7h9v9"},"children":[]}],"stethoscope":[{"tag":"path","attrs":{"d":"M6 3v6a6 6 0 0 0 12 0V3"},"children":[]},{"tag":"circle","attrs":{"cx":"18","cy":"17","r":"3"},"children":[]},{"tag":"path","attrs":{"d":"M12 15v2a3 3 0 0 0 6 0"},"children":[]}],"file":[{"tag":"path","attrs":{"d":"M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"},"children":[]},{"tag":"path","attrs":{"d":"M14 3v5h5"},"children":[]}],"kebab":[{"tag":"circle","attrs":{"cx":"12","cy":"5","r":"1"},"children":[]},{"tag":"circle","attrs":{"cx":"12","cy":"12","r":"1"},"children":[]},{"tag":"circle","attrs":{"cx":"12","cy":"19","r":"1"},"children":[]}],"flower":[{"tag":"circle","attrs":{"cx":"12","cy":"12","r":"3"},"children":[]},{"tag":"path","attrs":{"d":"M12 2v4M12 18v4M2 12h4M18 12h4M5 5l3 3M16 16l3 3M5 19l3-3M16 8l3-3"},"children":[]}],"pill":[{"tag":"rect","attrs":{"x":"3","y":"8","width":"18","height":"8","rx":"4","transform":"rotate(-45 12 12)"},"children":[]},{"tag":"path","attrs":{"d":"M9 15l6-6"},"children":[]}],"ruler":[{"tag":"rect","attrs":{"x":"2","y":"9","width":"20","height":"6","rx":"2","transform":"rotate(-45 12 12)"},"children":[]},{"tag":"path","attrs":{"d":"M8 13l1.5 1.5M11 10l1.5 1.5M14 7l1.5 1.5"},"children":[]}],"bag":[{"tag":"path","attrs":{"d":"M4 8h16l-1 12H5Z"},"children":[]},{"tag":"path","attrs":{"d":"M9 8V6a3 3 0 0 1 6 0v2"},"children":[]}],"alert-triangle":[{"tag":"path","attrs":{"d":"M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"},"children":[]},{"tag":"path","attrs":{"d":"M12 9v4M12 17h.01"},"children":[]}],"alert-circle":[{"tag":"circle","attrs":{"cx":"12","cy":"12","r":"10"},"children":[]},{"tag":"path","attrs":{"d":"M12 8v4M12 16h.01"},"children":[]}],"coffee":[{"tag":"path","attrs":{"d":"M17 8h1a4 4 0 1 1 0 8h-1M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z"},"children":[]},{"tag":"path","attrs":{"d":"M6 2v2M10 2v2M14 2v2"},"children":[]}],"book-open":[{"tag":"path","attrs":{"d":"M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2ZM22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7Z"},"children":[]}],"archive":[{"tag":"rect","attrs":{"x":"2","y":"3","width":"20","height":"5","rx":"1"},"children":[]},{"tag":"path","attrs":{"d":"M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4"},"children":[]}],"bar-chart-3":[{"tag":"path","attrs":{"d":"M3 3v18h18"},"children":[]},{"tag":"path","attrs":{"d":"M7 16v-5"},"children":[]},{"tag":"path","attrs":{"d":"M12 16V8"},"children":[]},{"tag":"path","attrs":{"d":"M17 16v-3"},"children":[]}],"share-2":[{"tag":"circle","attrs":{"cx":"18","cy":"5","r":"3"},"children":[]},{"tag":"circle","attrs":{"cx":"6","cy":"12","r":"3"},"children":[]},{"tag":"circle","attrs":{"cx":"18","cy":"19","r":"3"},"children":[]},{"tag":"path","attrs":{"d":"m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"},"children":[]}],"flask-conical":[{"tag":"path","attrs":{"d":"M10 2v7.5L4.2 19a2 2 0 0 0 1.7 3h12.2a2 2 0 0 0 1.7-3L14 9.5V2M8.5 2h7"},"children":[]}],"party-popper":[{"tag":"path","attrs":{"d":"M5.8 11.3 2 22l10.7-3.79"},"children":[]},{"tag":"path","attrs":{"d":"M4 3h.01"},"children":[]},{"tag":"path","attrs":{"d":"M22 8h.01"},"children":[]},{"tag":"path","attrs":{"d":"M15 2h.01"},"children":[]},{"tag":"path","attrs":{"d":"M22 20h.01"},"children":[]},{"tag":"path","attrs":{"d":"m22 2-2.24.75a2.9 2.9 0 0 0-1.96 3.12c.1.86-.57 1.63-1.45 1.63h-.38c-.86 0-1.6.6-1.76 1.44L14 10"},"children":[]},{"tag":"path","attrs":{"d":"m22 13-.82-.33c-.86-.34-1.82.2-1.98 1.11c-.11.7-.72 1.22-1.43 1.22H17"},"children":[]},{"tag":"path","attrs":{"d":"m11 2 .33.82c.34.86-.2 1.82-1.11 1.98C9.52 4.9 9 5.52 9 6.23V7"},"children":[]},{"tag":"path","attrs":{"d":"M11 13c1.93 1.93 2.83 4.17 2 5-.83.83-3.07-.07-5-2-1.93-1.93-2.83-4.17-2-5 .83-.83 3.07.07 5 2Z"},"children":[]}],"arrow-down":[{"tag":"path","attrs":{"d":"M12 5v14"},"children":[]},{"tag":"path","attrs":{"d":"m19 12-7 7-7-7"},"children":[]}],"skip-forward":[{"tag":"path","attrs":{"d":"M21 4v16"},"children":[]},{"tag":"path","attrs":{"d":"M6.029 4.285A2 2 0 0 0 3 6v12a2 2 0 0 0 3.029 1.715l9.997-5.998a2 2 0 0 0 .003-3.432z"},"children":[]}],"volume-2":[{"tag":"path","attrs":{"d":"M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"},"children":[]},{"tag":"path","attrs":{"d":"M16 9a5 5 0 0 1 0 6"},"children":[]},{"tag":"path","attrs":{"d":"M19.364 18.364a9 9 0 0 0 0-12.728"},"children":[]}],"volume-x":[{"tag":"path","attrs":{"d":"M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"},"children":[]},{"tag":"line","attrs":{"x1":"22","x2":"16","y1":"9","y2":"15"},"children":[]},{"tag":"line","attrs":{"x1":"16","x2":"22","y1":"9","y2":"15"},"children":[]}],"mic":[{"tag":"path","attrs":{"d":"M12 19v3"},"children":[]},{"tag":"path","attrs":{"d":"M19 10v2a7 7 0 0 1-14 0v-2"},"children":[]},{"tag":"rect","attrs":{"x":"9","y":"2","width":"6","height":"13","rx":"3"},"children":[]}],"video":[{"tag":"path","attrs":{"d":"m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"},"children":[]},{"tag":"rect","attrs":{"x":"2","y":"6","width":"14","height":"12","rx":"2"},"children":[]}],"camera":[{"tag":"path","attrs":{"d":"M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z"},"children":[]},{"tag":"circle","attrs":{"cx":"12","cy":"13","r":"3"},"children":[]}],"image":[{"tag":"rect","attrs":{"width":"18","height":"18","x":"3","y":"3","rx":"2","ry":"2"},"children":[]},{"tag":"circle","attrs":{"cx":"9","cy":"9","r":"2"},"children":[]},{"tag":"path","attrs":{"d":"m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"},"children":[]}],"key":[{"tag":"path","attrs":{"d":"m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4"},"children":[]},{"tag":"path","attrs":{"d":"m21 2-9.6 9.6"},"children":[]},{"tag":"circle","attrs":{"cx":"7.5","cy":"15.5","r":"5.5"},"children":[]}],"phone":[{"tag":"path","attrs":{"d":"M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384"},"children":[]}],"x-circle":[{"tag":"circle","attrs":{"cx":"12","cy":"12","r":"10"},"children":[]},{"tag":"path","attrs":{"d":"m15 9-6 6"},"children":[]},{"tag":"path","attrs":{"d":"m9 9 6 6"},"children":[]}],"timer":[{"tag":"line","attrs":{"x1":"10","x2":"14","y1":"2","y2":"2"},"children":[]},{"tag":"line","attrs":{"x1":"12","x2":"15","y1":"14","y2":"11"},"children":[]},{"tag":"circle","attrs":{"cx":"12","cy":"14","r":"8"},"children":[]}],"target":[{"tag":"circle","attrs":{"cx":"12","cy":"12","r":"10"},"children":[]},{"tag":"circle","attrs":{"cx":"12","cy":"12","r":"6"},"children":[]},{"tag":"circle","attrs":{"cx":"12","cy":"12","r":"2"},"children":[]}],"cloud":[{"tag":"path","attrs":{"d":"M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"},"children":[]}],"smartphone":[{"tag":"rect","attrs":{"width":"14","height":"20","x":"5","y":"2","rx":"2","ry":"2"},"children":[]},{"tag":"path","attrs":{"d":"M12 18h.01"},"children":[]}],"shopping-cart":[{"tag":"circle","attrs":{"cx":"8","cy":"21","r":"1"},"children":[]},{"tag":"circle","attrs":{"cx":"19","cy":"21","r":"1"},"children":[]},{"tag":"path","attrs":{"d":"M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"},"children":[]}],"credit-card":[{"tag":"rect","attrs":{"width":"20","height":"14","x":"2","y":"5","rx":"2"},"children":[]},{"tag":"line","attrs":{"x1":"2","x2":"22","y1":"10","y2":"10"},"children":[]}],"crown":[{"tag":"path","attrs":{"d":"M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z"},"children":[]},{"tag":"path","attrs":{"d":"M5 21h14"},"children":[]}],"dollar-sign":[{"tag":"line","attrs":{"x1":"12","x2":"12","y1":"2","y2":"22"},"children":[]},{"tag":"path","attrs":{"d":"M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"},"children":[]}],"package":[{"tag":"path","attrs":{"d":"M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"},"children":[]},{"tag":"path","attrs":{"d":"M12 22V12"},"children":[]},{"tag":"polyline","attrs":{"points":"3.29 7 12 12 20.71 7"},"children":[]},{"tag":"path","attrs":{"d":"m7.5 4.27 9 5.15"},"children":[]}],"gem":[{"tag":"path","attrs":{"d":"M10.5 3 8 9l4 13 4-13-2.5-6"},"children":[]},{"tag":"path","attrs":{"d":"M17 3a2 2 0 0 1 1.6.8l3 4a2 2 0 0 1 .013 2.382l-7.99 10.986a2 2 0 0 1-3.247 0l-7.99-10.986A2 2 0 0 1 2.4 7.8l2.998-3.997A2 2 0 0 1 7 3z"},"children":[]},{"tag":"path","attrs":{"d":"M2 9h20"},"children":[]}],"gift":[{"tag":"path","attrs":{"d":"M12 7v14"},"children":[]},{"tag":"path","attrs":{"d":"M20 11v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8"},"children":[]},{"tag":"path","attrs":{"d":"M7.5 7a1 1 0 0 1 0-5A4.8 8 0 0 1 12 7a4.8 8 0 0 1 4.5-5 1 1 0 0 1 0 5"},"children":[]},{"tag":"rect","attrs":{"x":"3","y":"7","width":"18","height":"4","rx":"1"},"children":[]}],"wallet":[{"tag":"path","attrs":{"d":"M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"},"children":[]},{"tag":"path","attrs":{"d":"M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"},"children":[]}],"award":[{"tag":"path","attrs":{"d":"m15.477 12.89 1.515 8.526a.5.5 0 0 1-.81.47l-3.58-2.687a1 1 0 0 0-1.197 0l-3.586 2.686a.5.5 0 0 1-.81-.469l1.514-8.526"},"children":[]},{"tag":"circle","attrs":{"cx":"12","cy":"8","r":"6"},"children":[]}],"trophy":[{"tag":"path","attrs":{"d":"M10 14.66v1.626a2 2 0 0 1-.976 1.696A5 5 0 0 0 7 21.978"},"children":[]},{"tag":"path","attrs":{"d":"M14 14.66v1.626a2 2 0 0 0 .976 1.696A5 5 0 0 1 17 21.978"},"children":[]},{"tag":"path","attrs":{"d":"M18 9h1.5a1 1 0 0 0 0-5H18"},"children":[]},{"tag":"path","attrs":{"d":"M4 22h16"},"children":[]},{"tag":"path","attrs":{"d":"M6 9a6 6 0 0 0 12 0V3a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1z"},"children":[]},{"tag":"path","attrs":{"d":"M6 9H4.5a1 1 0 0 1 0-5H6"},"children":[]}],"user-plus":[{"tag":"path","attrs":{"d":"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"},"children":[]},{"tag":"circle","attrs":{"cx":"9","cy":"7","r":"4"},"children":[]},{"tag":"line","attrs":{"x1":"19","x2":"19","y1":"8","y2":"14"},"children":[]},{"tag":"line","attrs":{"x1":"22","x2":"16","y1":"11","y2":"11"},"children":[]}],"flame":[{"tag":"path","attrs":{"d":"M12 3q1 4 4 6.5t3 5.5a1 1 0 0 1-14 0 5 5 0 0 1 1-3 1 1 0 0 0 5 0c0-2-1.5-3-1.5-5q0-2 2.5-4"},"children":[]}],"maximize":[{"tag":"path","attrs":{"d":"M8 3H5a2 2 0 0 0-2 2v3"},"children":[]},{"tag":"path","attrs":{"d":"M21 8V5a2 2 0 0 0-2-2h-3"},"children":[]},{"tag":"path","attrs":{"d":"M3 16v3a2 2 0 0 0 2 2h3"},"children":[]},{"tag":"path","attrs":{"d":"M16 21h3a2 2 0 0 0 2-2v-3"},"children":[]}],"pointer":[{"tag":"path","attrs":{"d":"M22 14a8 8 0 0 1-8 8"},"children":[]},{"tag":"path","attrs":{"d":"M18 11v-1a2 2 0 0 0-2-2a2 2 0 0 0-2 2"},"children":[]},{"tag":"path","attrs":{"d":"M14 10V9a2 2 0 0 0-2-2a2 2 0 0 0-2 2v1"},"children":[]},{"tag":"path","attrs":{"d":"M10 9.5V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v10"},"children":[]},{"tag":"path","attrs":{"d":"M18 11a2 2 0 1 1 4 0v3a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"},"children":[]}],"paintbrush":[{"tag":"path","attrs":{"d":"m14.622 17.897-10.68-2.913"},"children":[]},{"tag":"path","attrs":{"d":"M18.376 2.622a1 1 0 1 1 3.002 3.002L17.36 9.643a.5.5 0 0 0 0 .707l.944.944a2.41 2.41 0 0 1 0 3.408l-.944.944a.5.5 0 0 1-.707 0L8.354 7.348a.5.5 0 0 1 0-.707l.944-.944a2.41 2.41 0 0 1 3.408 0l.944.944a.5.5 0 0 0 .707 0z"},"children":[]},{"tag":"path","attrs":{"d":"M9 8c-1.804 2.71-3.97 3.46-6.583 3.948a.507.507 0 0 0-.302.819l7.32 8.883a1 1 0 0 0 1.185.204C12.735 20.405 16 16.792 16 15"},"children":[]}],"ban":[{"tag":"circle","attrs":{"cx":"12","cy":"12","r":"10"},"children":[]},{"tag":"path","attrs":{"d":"M4.929 4.929 19.07 19.071"},"children":[]}],"notebook":[{"tag":"path","attrs":{"d":"M2 6h4"},"children":[]},{"tag":"path","attrs":{"d":"M2 10h4"},"children":[]},{"tag":"path","attrs":{"d":"M2 14h4"},"children":[]},{"tag":"path","attrs":{"d":"M2 18h4"},"children":[]},{"tag":"rect","attrs":{"width":"16","height":"20","x":"4","y":"2","rx":"2"},"children":[]},{"tag":"path","attrs":{"d":"M16 2v20"},"children":[]}],"folder-open":[{"tag":"path","attrs":{"d":"m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"},"children":[]}],"circle-dashed":[{"tag":"path","attrs":{"d":"M10.1 2.182a10 10 0 0 1 3.8 0"},"children":[]},{"tag":"path","attrs":{"d":"M13.9 21.818a10 10 0 0 1-3.8 0"},"children":[]},{"tag":"path","attrs":{"d":"M17.609 3.721a10 10 0 0 1 2.69 2.7"},"children":[]},{"tag":"path","attrs":{"d":"M2.182 13.9a10 10 0 0 1 0-3.8"},"children":[]},{"tag":"path","attrs":{"d":"M20.279 17.609a10 10 0 0 1-2.7 2.69"},"children":[]},{"tag":"path","attrs":{"d":"M21.818 10.1a10 10 0 0 1 0 3.8"},"children":[]},{"tag":"path","attrs":{"d":"M3.721 6.391a10 10 0 0 1 2.7-2.69"},"children":[]},{"tag":"path","attrs":{"d":"M6.391 20.279a10 10 0 0 1-2.69-2.7"},"children":[]}],"shuffle":[{"tag":"path","attrs":{"d":"m18 14 4 4-4 4"},"children":[]},{"tag":"path","attrs":{"d":"m18 2 4 4-4 4"},"children":[]},{"tag":"path","attrs":{"d":"M2 18h1.973a4 4 0 0 0 3.3-1.7l5.454-8.6a4 4 0 0 1 3.3-1.7H22"},"children":[]},{"tag":"path","attrs":{"d":"M2 6h1.972a4 4 0 0 1 3.6 2.2"},"children":[]},{"tag":"path","attrs":{"d":"M22 18h-6.041a4 4 0 0 1-3.3-1.8l-.359-.45"},"children":[]}],"briefcase":[{"tag":"path","attrs":{"d":"M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"},"children":[]},{"tag":"rect","attrs":{"width":"20","height":"14","x":"2","y":"6","rx":"2"},"children":[]}],"settings-2":[{"tag":"path","attrs":{"d":"M14 17H5"},"children":[]},{"tag":"path","attrs":{"d":"M19 7h-9"},"children":[]},{"tag":"circle","attrs":{"cx":"17","cy":"17","r":"3"},"children":[]},{"tag":"circle","attrs":{"cx":"7","cy":"7","r":"3"},"children":[]}],"wind":[{"tag":"path","attrs":{"d":"M12.8 19.6A2 2 0 1 0 14 16H2"},"children":[]},{"tag":"path","attrs":{"d":"M17.5 8a2.5 2.5 0 1 1 2 4H2"},"children":[]},{"tag":"path","attrs":{"d":"M9.8 4.4A2 2 0 1 1 11 8H2"},"children":[]}],"layers":[{"tag":"path","attrs":{"d":"M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"},"children":[]},{"tag":"path","attrs":{"d":"M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"},"children":[]},{"tag":"path","attrs":{"d":"M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"},"children":[]}],"keyboard":[{"tag":"path","attrs":{"d":"M10 8h.01"},"children":[]},{"tag":"path","attrs":{"d":"M12 12h.01"},"children":[]},{"tag":"path","attrs":{"d":"M14 8h.01"},"children":[]},{"tag":"path","attrs":{"d":"M16 12h.01"},"children":[]},{"tag":"path","attrs":{"d":"M18 8h.01"},"children":[]},{"tag":"path","attrs":{"d":"M6 8h.01"},"children":[]},{"tag":"path","attrs":{"d":"M7 16h10"},"children":[]},{"tag":"path","attrs":{"d":"M8 12h.01"},"children":[]},{"tag":"rect","attrs":{"width":"20","height":"16","x":"2","y":"4","rx":"2"},"children":[]}],"bug":[{"tag":"path","attrs":{"d":"M12 20v-9"},"children":[]},{"tag":"path","attrs":{"d":"M14 7a4 4 0 0 1 4 4v3a6 6 0 0 1-12 0v-3a4 4 0 0 1 4-4z"},"children":[]},{"tag":"path","attrs":{"d":"M14.12 3.88 16 2"},"children":[]},{"tag":"path","attrs":{"d":"M21 21a4 4 0 0 0-3.81-4"},"children":[]},{"tag":"path","attrs":{"d":"M21 5a4 4 0 0 1-3.55 3.97"},"children":[]},{"tag":"path","attrs":{"d":"M22 13h-4"},"children":[]},{"tag":"path","attrs":{"d":"M3 21a4 4 0 0 1 3.81-4"},"children":[]},{"tag":"path","attrs":{"d":"M3 5a4 4 0 0 0 3.55 3.97"},"children":[]},{"tag":"path","attrs":{"d":"M6 13H2"},"children":[]},{"tag":"path","attrs":{"d":"m8 2 1.88 1.88"},"children":[]},{"tag":"path","attrs":{"d":"M9 7.13V6a3 3 0 1 1 6 0v1.13"},"children":[]}],"crop":[{"tag":"path","attrs":{"d":"M6 2v14a2 2 0 0 0 2 2h14"},"children":[]},{"tag":"path","attrs":{"d":"M18 22V8a2 2 0 0 0-2-2H2"},"children":[]}]}
type IconNode = { tag:string; attrs:Record<string,string>; children:IconNode[] }

// ---- registry/cojeev/motion/refs.ts (inlined) ----
/** React 19 callback refs may return their own teardown; object refs are mutable commit targets. */
function assignMotionRef<T>(ref:React.Ref<T>|undefined,value:T|null):()=>void{
 if(typeof ref==='function'){
  const cleanup=ref(value)
  return ()=>{if(typeof cleanup==='function')cleanup();else ref(null)}
 }
 if(ref)ref.current=value
 return ()=>{if(ref)ref.current=null}
}

// ---- registry/cojeev/motion/clock.ts (inlined) ----
let time:number|null=null
const drivers=new Set<(time:number|null)=>void>()
const now=()=>time??performance.now()
function registerMotionClock(driver:(time:number|null)=>void){drivers.add(driver);return ()=>{drivers.delete(driver)}}
function getMotionTime(){return now()}
function isMotionClockFrozen(){return time!==null}

// ---- registry/cojeev/motion/settings.ts (inlined) ----
const RUNTIME={cfg:{rest:false,reach:true,merge:true,hold:true,jiggleOn:true,press:true,echo:false,dots:0,grain:.08,sheen:.6,curve:1.2,lobeK:130,lobeZ:1,mergeZ:.8,arcK:40,holdK:80,pressK:170,jiggle:.35,jiggleDecay:1.6,restSpeed:1,drift:1,quality:2.5},
 tier:{pill:{amp:0,reach:3,inside:1.2,press:.02},tile:{amp:0,reach:2.4,inside:1,press:.02},nav:{amp:0,reach:1.2,inside:.5,press:.008},card:{amp:0,reach:1,inside:.4,press:.004},blob:{amp:.006,reach:3,inside:1.2,press:.03}}};
const factoryTiers={pill:{amp:.008,reach:4,inside:2,sig:24,R:80,press:.03,lobes:0,depth:0,asym:0,spread:.55},tile:{amp:.008,reach:3.5,inside:1.6,sig:18,R:64,press:.035,lobes:0,depth:0,asym:0,spread:.55},nav:{amp:.0006,reach:3,inside:1.2,sig:24,R:64,press:.010,lobes:0,depth:0,asym:0,spread:.55},card:{amp:.0003,reach:2.5,inside:.9,sig:44,R:56,press:.004,lobes:0,depth:0,asym:0,spread:.55},blob:{amp:.012,reach:4,inside:1.8,sig:22,R:64,press:.05,lobes:0,depth:0,asym:0,spread:.55},spinner:{amp:.14,reach:0,inside:0,sig:1,R:0,press:0,lobes:0,depth:0,asym:0,spread:.55}};
const factoryCfg={quality:2.5,grain:.12,sheen:1,curve:1,lobeK:90,lobeZ:.9,mergeZ:.62,arcK:26,holdK:55,pressK:140,jiggle:.45,jiggleDecay:1.35,restSpeed:1,drift:1,rest:true,reach:true,merge:true,hold:true,jiggleOn:true,press:true,echo:false,echoOff:6,echoScale:1.04,dots:0};
type MorphConfig = typeof factoryCfg
type TierName = keyof typeof factoryTiers
type Tier = typeof factoryTiers.pill
type ProductCategory = "buttons" | "icons" | "pills" | "cards" | "skeleton"
type Category = ProductCategory | "nav" | "inputs" | "controls" | "surfaces"
type MotionSettings = {v:3;mode:"off"|"subtle";cats:Record<Category,boolean>}
type MorphProfile = {cfg:MorphConfig;TIER:Record<TierName,Tier>}
type FlowVariant = "glide"|"stretch"|"jelly"|"comet"|"drop"|"rubber"|"pebble"|"ripple"|"halo"|"off"
type FlowSettings = {variant:FlowVariant;hover:boolean;speed:number;intensity:number;hoverStrength:number}
type SettingsSnapshot = Readonly<{motion:MotionSettings;flow:FlowSettings;profile:MorphProfile;authored:boolean}>
const MOTION_KEY = "v-motion"
const MORPH_KEY = "v-morph-cfg-v3"
const FLOW_KEY = "v-flow-v1"
const PRODUCT_CATEGORIES:readonly ProductCategory[] = ["buttons","icons","pills","cards","skeleton"]
const FLOW_DEFAULTS:Readonly<FlowSettings> = Object.freeze({variant:"glide",hover:true,speed:1,intensity:1,hoverStrength:1})
const FLOW_CHARACTERS:Record<FlowVariant,{label:string;duration:number;ease:string;land:string;glow?:string}> = {
 glide:{label:"Glide",duration:.24,ease:"cubic-bezier(.2,.8,.2,1)",land:"none"},
 stretch:{label:"Stretch",duration:.3,ease:"cubic-bezier(.3,1.15,.4,1)",land:"vf-land"},
 jelly:{label:"Jelly",duration:.5,ease:"cubic-bezier(.3,1.3,.45,1)",land:"vf-jellyx"},
 comet:{label:"Comet",duration:.34,ease:"cubic-bezier(.2,.8,.2,1)",land:"vf-land"},
 drop:{label:"Ink drop",duration:.3,ease:"cubic-bezier(.3,1.25,.4,1)",land:"vf-bloom"},
 rubber:{label:"Rubber",duration:.36,ease:"cubic-bezier(.3,1.3,.4,1)",land:"vf-land"},
 pebble:{label:"Pebble",duration:.46,ease:"cubic-bezier(.32,1.25,.42,1)",land:"vf-lean"},
 ripple:{label:"Ripple",duration:.36,ease:"cubic-bezier(.2,.8,.2,1)",land:"vf-land",glow:"vf-ring"},
 halo:{label:"Halo",duration:.4,ease:"cubic-bezier(.3,1.2,.4,1)",land:"vf-land",glow:"vf-glow"},
 off:{label:"Off",duration:0,ease:"linear",land:"none"},
}
const defaultSettings:MotionSettings={v:3,mode:"subtle",cats:{buttons:true,icons:true,pills:true,cards:false,skeleton:true,nav:false,inputs:false,controls:false,surfaces:false}}
function runtime():MorphProfile {
 const TIER=structuredClone(factoryTiers)
 for(const name of Object.keys(RUNTIME.tier) as (keyof typeof RUNTIME.tier)[]) Object.assign(TIER[name],RUNTIME.tier[name])
 return {cfg:{...factoryCfg,...RUNTIME.cfg},TIER}
}
function immutable<T>(value:T):T {
 if(value && typeof value==="object"){Object.values(value).forEach(immutable);Object.freeze(value)}
 return value
}
const serverSnapshot:SettingsSnapshot=immutable({motion:structuredClone(defaultSettings),flow:{...FLOW_DEFAULTS},profile:runtime(),authored:false})
let settings=structuredClone(defaultSettings), profile=runtime(), flow={...FLOW_DEFAULTS}, authored=false, loaded=false
let snapshot=serverSnapshot
const listeners=new Set<()=>void>()
let releaseEvents:undefined|(()=>void), dispatching=false
function storage(){try{return typeof window==="undefined"?null:window.localStorage}catch{return null}}
function parse(key:string):unknown {try{return JSON.parse(storage()?.getItem(key)||"null")}catch{return null}}
function record(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==="object"&&!Array.isArray(value)}
function mergeProfile(value:unknown,base:MorphProfile,strict=false):MorphProfile {
 if(!record(value)||(!record(value.cfg)&&!record(value.TIER)))throw new Error("Profile must contain a cfg or TIER object.")
 const next=structuredClone(base)
 if(record(value.cfg)) for(const key of Object.keys(next.cfg) as (keyof MorphConfig)[]){
  const v=value.cfg[key];if(v===undefined)continue
  if(typeof v!==typeof next.cfg[key]||(typeof v==="number"&&!Number.isFinite(v))){if(strict)throw new Error(`Invalid cfg.${key}: expected a finite ${typeof next.cfg[key]}.`);continue}
  Object.assign(next.cfg,{[key]:v})
 }
 if(record(value.TIER))for(const name of Object.keys(next.TIER) as TierName[]){const saved=value.TIER[name];if(!record(saved))continue
  for(const key of Object.keys(next.TIER[name]) as (keyof Tier)[]){const v=saved[key];if(v===undefined)continue
   if(typeof v!=="number"||!Number.isFinite(v)){if(strict)throw new Error(`Invalid TIER.${name}.${key}: expected a finite number.`);continue}
   next.TIER[name][key]=v
  }
 }
 return next
}
function normalizeFlow(value:unknown):FlowSettings {
 const v=record(value)?value:{},number=(key:string,fallback:number,min:number)=>typeof v[key]==="number"&&Number.isFinite(v[key])?Math.max(min,v[key] as number):fallback
 return {variant:typeof v.variant==="string"&&Object.hasOwn(FLOW_CHARACTERS,v.variant)?v.variant as FlowVariant:"glide",hover:typeof v.hover==="boolean"?v.hover:true,speed:number("speed",1,.25),intensity:number("intensity",1,0),hoverStrength:number("hoverStrength",1,0)}
}
function flowToken(name:string,fallback:string,el?:Element){try{return getComputedStyle(el??document.documentElement).getPropertyValue(name).trim()||fallback}catch{return fallback}}
function flowTokenMs(name:string,fallback:number,el?:Element){const v=flowToken(name,"",el),n=parseFloat(v);return Number.isFinite(n)?n*(v.endsWith("ms")?1:1000):fallback}
function applyFlowSettings(){
 if(typeof document==="undefined")return
 const h=document.documentElement,variant=settings.mode==="off"?"off":flow.variant,c=FLOW_CHARACTERS[variant],hover=flow.hover?"on":"off"
 // Read the character tokens before any root write: a computed read after one forces a
 // whole-document style pass. Unchanged writes are skipped, as they still wake every observer.
 const values:Record<string,string>={"--flow-speed":String(flow.speed),"--flow-intensity":String(flow.intensity),"--flow-hover":String(flow.hoverStrength),
  "--flow-ease":variant==="off"?c.ease:flowToken("--e-flow-"+variant,c.ease),
  "--flow-dur":((variant==="off"?0:flowTokenMs("--t-flow-"+variant,c.duration*1000))/1000/flow.speed).toFixed(3)+"s",
  "--flow-land":c.land,"--flow-glow":c.glow||"none"}
 if(h.dataset.flow!==variant)h.dataset.flow=variant
 if(h.dataset.flowHover!==hover)h.dataset.flowHover=hover
 for(const [name,value] of Object.entries(values))if(h.style.getPropertyValue(name)!==value)h.style.setProperty(name,value)
}
function publish(){
 const next={motion:settings,flow,profile,authored}
 if(JSON.stringify(next)===JSON.stringify(snapshot)){applyFlowSettings();return}
 snapshot=immutable(structuredClone(next));applyFlowSettings();listeners.forEach(fn=>fn())
}
function loadMotionSettings(){
 if(loaded||typeof window==="undefined")return
 loaded=true;settings=structuredClone(defaultSettings);profile=runtime();flow={...FLOW_DEFAULTS};authored=false
 const raw=parse(MOTION_KEY)
 if(record(raw)){
  if(raw.mode==="off"||raw.mode==="subtle")settings.mode=raw.mode
  if(raw.v===3&&record(raw.cats))for(const key of PRODUCT_CATEGORIES)if(typeof raw.cats[key]==="boolean")settings.cats[key]=raw.cats[key]
 }
 flow=normalizeFlow(parse(FLOW_KEY))
 const saved=parse(MORPH_KEY)
 if(saved)try{profile=mergeProfile(saved,{cfg:{...factoryCfg},TIER:structuredClone(factoryTiers)});authored=true}catch{/* Corrupt saved data keeps a usable runtime. */}
 try{for(const key of ["v-alive-settings","v-morph-cfg","v-morph-cfg-v2","v-motion-cfg"])storage()?.removeItem(key)}catch{}
 publish()
}
function getMotionSettings(){loadMotionSettings();return structuredClone(settings)}
function getFlowSettings(){loadMotionSettings();return {...flow}}
function getSettingsSnapshot(){loadMotionSettings();return snapshot}
function getServerSettingsSnapshot(){return serverSnapshot}
function reloadMotionSettings(){loaded=false;loadMotionSettings()}
function acquireEvents(){
 if(releaseEvents||typeof window==="undefined")return
 const onStorage=(event:StorageEvent)=>{if(event.key===null||[MOTION_KEY,MORPH_KEY,FLOW_KEY].includes(event.key))reloadMotionSettings()}
 const onEngine=()=>{if(!dispatching)reloadMotionSettings()}
 window.addEventListener("storage",onStorage);window.addEventListener("v-motion-change",onEngine);window.addEventListener("v-flow",onEngine)
 releaseEvents=()=>{window.removeEventListener("storage",onStorage);window.removeEventListener("v-motion-change",onEngine);window.removeEventListener("v-flow",onEngine);releaseEvents=undefined}
}
function subscribeSettings(fn:()=>void){loadMotionSettings();listeners.add(fn);acquireEvents();return ()=>{listeners.delete(fn);if(!listeners.size)releaseEvents?.()}}
function event(name:string){if(typeof window==="undefined")return;dispatching=true;try{window.dispatchEvent(new CustomEvent(name,{detail:name==="v-flow"?getFlowSettings():getMotionSettings()}))}finally{dispatching=false}}

// ---- registry/cojeev/motion/use-reduced-motion.ts (inlined) ----
let query:MediaQueryList|undefined
const listeners_UseReducedMotion=new Set<()=>void>()
const changed=()=>listeners_UseReducedMotion.forEach(listener=>listener())
function media(){return query??=window.matchMedia('(prefers-reduced-motion: reduce)')}
function subscribe(listener:()=>void){
 const q=media();if(!listeners_UseReducedMotion.size)q.addEventListener('change',changed);listeners_UseReducedMotion.add(listener)
 return ()=>{listeners_UseReducedMotion.delete(listener);if(!listeners_UseReducedMotion.size){q.removeEventListener('change',changed);query=undefined}}
}
function snapshot_UseReducedMotion(){return typeof window==='undefined'?false:media().matches}
const serverSnapshot_UseReducedMotion=()=>false
/** Dynamic accessibility preference shared by genuine in-progress indicators and other component roles. */
function useReducedMotion(){return useSyncExternalStore(subscribe,snapshot_UseReducedMotion,serverSnapshot_UseReducedMotion)}

// ---- registry/cojeev/motion/choreography.ts (inlined) ----
/** The shared rhythm. Durations and stagger are seconds, matching Motion's API. */
const motionTokens = {
  spring: {
    responsive: { type: "spring", stiffness: 360, damping: 32, mass: .85 },
    expressive: { type: "spring", stiffness: 260, damping: 22, mass: 1 },
    gentle: { type: "spring", stiffness: 180, damping: 28, mass: 1 },
  },
  ease: { enter: [.2, .8, .2, 1], exit: [.4, 0, 1, 1], settle: [.2, .65, .25, 1] },
  duration: { quick: .16, enter: .32, exit: .18 },
  stagger: .035,
} as const;
const isQuiet = (snapshot: SettingsSnapshot) => snapshot.motion.mode === "off" || snapshot.flow.variant === "off";
function resolveChoreography(snapshot: SettingsSnapshot, reduced: boolean): { quiet: boolean; transition: Transition } {
  const quiet = reduced || isQuiet(snapshot);
  if (quiet) return { quiet, transition: { duration: 0, delay: 0 } };
  const speed = snapshot.flow.speed;
  const spring = ["jelly", "rubber", "drop", "pebble"].includes(snapshot.flow.variant)
    ? motionTokens.spring.expressive : motionTokens.spring.responsive;
  return { quiet, transition: { ...spring, stiffness: spring.stiffness * speed * speed, damping: spring.damping * speed } };
}
/** Reactive settings subscription for reusable React surfaces. */
function useChoreography() {
  const snapshot = React.useSyncExternalStore(subscribeSettings, getSettingsSnapshot, getServerSettingsSnapshot);
  const reduced = useReducedMotion();
  return React.useMemo(() => resolveChoreography(snapshot, reduced), [snapshot, reduced]);
}
/** Connect Motion's JS animations to the existing deterministic document clock. */
function trackMotion(controls: AnimationPlaybackControls) {
  let origin = getMotionTime() - controls.time * 1000;
  let frozen = isMotionClockFrozen();
  if (frozen) controls.pause();
  const release = registerMotionClock(time => {
    if (time === null) {
      if (frozen) controls.play();
      frozen = false;
      return;
    }
    if (!frozen) {
      origin = time - controls.time * 1000;
      controls.pause();
      frozen = true;
    }
    controls.time = Math.max(0, time - origin) / 1000;
    if (controls.time >= controls.duration) controls.complete();
    // A seek schedules Motion's update phase. Flush it at this explicit sample;
    // normal playback stays entirely on Motion's own animation frame loop.
    frameSteps.update.process({ delta: 0, timestamp: performance.now(), isProcessing: false });
  });
  void controls.finished.then(release, release);
  return () => { release(); controls.stop(); };
}
/** One interruptible spring per scalar; retargets inherit the current value and velocity. */
function createMotionLane(initial: number, render: (value: number) => void) {
  const value = motionValue(initial);
  const unsubscribe = value.on("change", render);
  let cancel = () => {};
  let generation = 0;
  const stop = () => { generation++; cancel(); cancel = () => {}; value.stop(); };
  const jump = (target: number) => { stop(); value.jump(target); render(target); };
  return {
    get: () => value.get(),
    jump,
    to(target: number, transition: Transition, complete?: () => void) {
      stop();
      if (transition.duration === 0) { jump(target); complete?.(); return; }
      const owner = generation;
      const controls = animate(value, target, {
        ...transition,
        autoplay: !isMotionClockFrozen(),
        onComplete: () => { if (generation === owner) complete?.(); },
      });
      cancel = trackMotion(controls);
    },
    stop,
    dispose: () => { stop(); unsubscribe(); value.destroy(); },
  };
}

// ---- registry/cojeev/ui/icon.tsx (inlined) ----
const lucideIconNames: string[]=[]
// Small authored additions share the pack's 24px stroke geometry.
const extraPaths: Record<string, string[]> = {
  "corner-down-left": ["m9 10-5 5 5 5", "M20 4v7a4 4 0 0 1-4 4H4"],
  github: ["M9 19c-4.3 1.3-4.3-2.2-6-2.7M15 22v-3.8c0-1.1-.4-1.8-.8-2.2 2.7-.3 5.5-1.3 5.5-6A4.7 4.7 0 0 0 18.4 6a4.4 4.4 0 0 0-.1-3.9S17.2 1.7 14.5 3a13 13 0 0 0-7 0C4.8 1.7 3.7 2.1 3.7 2.1A4.4 4.4 0 0 0 3.6 6a4.7 4.7 0 0 0-1.3 3.3c0 4.7 2.8 5.7 5.5 6-.4.4-.8 1.2-.8 2.2V22"],
  save: ["M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12l4 4v12a2 2 0 0 1-2 2Z", "M7 3v6h9V3M7 21v-8h10v8"],
  "circle-help": ["M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2-3 4M12 17h.01", "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0"],
  menu: ["M4 6h16M4 12h16M4 18h16"],
  mail: ["M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z", "m22 6-10 7L2 6"],
  link: ["M10 13a5 5 0 0 0 7 .3l3-3a5 5 0 0 0-7-7l-1.8 1.8M14 11a5 5 0 0 0-7-.3l-3 3a5 5 0 0 0 7 7l1.8-1.8"],
  code: ["m8 5-7 7 7 7m8-14 7 7-7 7m-3-16-2 18"],
  compass: ["M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0", "m16 8-3 5-5 3 3-5 5-3Z"],
  "folder-plus": ["M3 7V5a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z", "M12 10v7m-3-3.5h6"],
  "undo-2": ["M3 10h11a6 6 0 0 1 0 12M7 6l-4 4 4 4"],
  "redo-2": ["M21 10H10a6 6 0 0 0 0 12M17 6l4 4-4 4"],
  globe: ["M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0M2 12h20M12 2c5 5.5 5 14.5 0 20-5-5.5-5-14.5 0-20Z"],
  "log-in": ["M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M3 12h12m-4-4 4 4-4 4"],
  filter: ["M3 4h18l-7 8v7l-4 2v-9L3 4Z"],
  palette: ["M12 3a9 9 0 0 0 0 18h1a2 2 0 0 0 1.4-3.4 1 1 0 0 1 .7-1.6H17a4 4 0 0 0 4-4c0-5-4-9-9-9Z", "M7.5 9h.01M10 6h.01M15 6.5h.01M17.5 10h.01"],
  rocket: ["M12 15c-3 0-6-3-6-3C7 6 12 2 21 3c1 9-3 14-9 15l-3-3M6 12H3l2-5h3M12 18v3l5-2v-3", "m4 16-2 6 6-2M15 8h.01"],
  "arrow-up": ["M12 19V5m-7 7 7-7 7 7"],
  paperclip: ["m21.4 11.6-9.2 9.2a6 6 0 0 1-8.5-8.5l10-10a4 4 0 0 1 5.7 5.7l-10 10a2 2 0 0 1-2.8-2.8l9.2-9.2"],
  square: ["M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"],
  "shield-check": ["M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z", "m8 12 3 3 5-6"],
};
const additionalIcons = Object.fromEntries(Object.entries(extraPaths).map(([name, paths]) => [name, paths.map(d => ({ tag: "path", attrs: { d }, children: [] }))])) as Record<string, IconNode[]>;
// A small authored set for the gallery's most-recognized marks. These are line silhouettes,
// not a decorative plate; the broad Lucide pack keeps its original geometry where a safe contour
// conversion cannot be inferred.
const organicIconGeometry:Record<string,IconNode[]>={
  camera:[{tag:"path",attrs:{d:"M4 7.6 Q5 7 7 7.4 L8.3 5.2 Q9.1 4 10.3 4.2 L13.8 4.1 Q15.1 4 15.8 5.3 L16.7 7.2 Q18 7 20 7.8 Q21.3 8.6 21 10.1 L21 17.8 Q20.8 20 18.8 20 L5.1 20 Q3 19.8 3 17.8 L3 10 Q3 8.3 4 7.6"},children:[]},{tag:"path",attrs:{d:"M9 13 Q9 9.8 12.1 9.8 Q15.2 10 15.1 13 Q15 16.1 12 16.2 Q9 16 9 13"},children:[]}],
  heart:[{tag:"path",attrs:{d:"M20.4 8.4 Q20.2 4.4 16.7 4.2 Q13.8 4.1 12 6.8 Q10.1 4 7.3 4.3 Q3.7 4.7 3.6 8.5 Q3.7 12.2 12 20 Q20.3 12.4 20.4 8.4"},children:[]}],
  leaf:[{tag:"path",attrs:{d:"M20 4 Q11.8 3.7 7.4 8 Q3.8 11.6 4.1 17.6 Q10.2 18 14 14.2 Q18.2 10.2 20 4"},children:[]},{tag:"path",attrs:{d:"M4.5 19.5 Q9.5 14.2 15.8 8.7"},children:[]}],
  search:[{tag:"path",attrs:{d:"M18.5 10.8 Q18.5 3.8 11.2 3.6 Q4 3.8 3.7 10.8 Q3.8 17.8 10.8 18 Q14.2 18 16.4 15.8"},children:[]},{tag:"path",attrs:{d:"M16.1 16.1 Q18.7 18.6 21 21"},children:[]}],
  check:[{tag:"path",attrs:{d:"M4.8 12.2 Q7.2 14.8 9.8 17 Q14.8 11 19.8 6"},children:[]}],
  "arrow-right":[{tag:"path",attrs:{d:"M4 12 Q11.8 11.5 20 12"},children:[]},{tag:"path",attrs:{d:"M14 6 Q17.1 8.9 20 12 Q17.1 15.1 14 18"},children:[]}],
};
// Friendly action names reuse existing geometry; legacy Lucide names remain valid.
const iconAliases: Record<string, string> = {
  "check-circle":"circle-check", close:"x", alert:"triangle-alert",
  loader:"loader-circle", refresh:"refresh-cw", trash:"trash-2",
  home:"house", "help-circle":"circle-help", "plus-circle":"circle-plus", "more-horizontal":"ellipsis",
};
const canonicalIcon = (name:string) => iconAliases[name] ?? name;
// Preserve authored part ordering: existing motion recipes depend on these silhouettes.
const geometryCache=new Map<string,IconNode[]>();
// The full Lucide geometry is several hundred kilobytes, so it stays out of every
// bundle that renders an Icon and loads on first use of a name the authored set lacks.
// Until it arrives such an icon keeps its fixed footprint with no strokes.
type LucidePack={getLucideIcon:(name:string)=>IconNode[]|undefined};
const lucideNameSet=new Set(lucideIconNames);
let lucidePack:LucidePack|null=null;
let lucideLoad:Promise<LucidePack>|null=null;
const lucideListeners=new Set<()=>void>();
/**
 * Resolves once every Lucide name renders synchronously. In a browser, call it any time to fetch the pack
 * early; icons still hydrate without strokes and fill in right after. On a server, call it only before
 * markup that is never hydrated (tests, static snapshots): HTML that React hydrates must be rendered
 * without the pack, or hydration mismatches.
 */
function loadLucideIcons():Promise<LucidePack> {
  return lucideLoad??=Promise.reject<LucidePack>(new Error("The Lucide icon pack is not part of this single-file package")).then(pack=>{
    lucidePack=pack;
    for(const listener of lucideListeners)listener();
    return pack;
  },error=>{
    // A dropped chunk must not blank these icons for the session: the next request tries again.
    lucideLoad=null;
    throw error;
  });
}
function isKnownIcon(name:string){name=canonicalIcon(name);return name in iconData||name in additionalIcons||lucideNameSet.has(name)}
function iconGeometry(name:string):IconNode[]|undefined {
  name=canonicalIcon(name);
  const known=iconData[name]??additionalIcons[name]??geometryCache.get(name);
  if(known||!lucidePack)return known;
  const nodes=lucidePack.getLucideIcon(name);
  if(nodes)geometryCache.set(name,nodes);
  return nodes;
}
const subscribeLucide=(listener:()=>void)=>{lucideListeners.add(listener);return()=>{lucideListeners.delete(listener)}};
const lucideReady=()=>lucidePack!==null;
// Hydration must reproduce the server HTML, which a static render produced without the pack. A lazily
// hydrated boundary can start after another icon has already fetched it, so in the browser the server
// snapshot is always "not loaded"; outside a browser (server renders, tests) it reports the real state.
const lucideReadyOnServer=()=>typeof window==="undefined"&&lucidePack!==null;
function useIconGeometry(name:string):IconNode[]|undefined {
  const canonical=canonicalIcon(name);
  const authored=iconData[canonical]??additionalIcons[canonical];
  const fromPack=!authored&&lucideNameSet.has(canonical);
  const ready=React.useSyncExternalStore(subscribeLucide,lucideReady,lucideReadyOnServer);
  // A failed load keeps the footprint; the next icon that asks retries it.
  React.useEffect(()=>{if(fromPack&&!ready)loadLucideIcons().catch(()=>{})},[fromPack,ready]);
  if(authored)return authored;
  return fromPack&&ready?iconGeometry(name):undefined;
}
/** Direction is geometric, independent of document reading direction. */
function getIconDirection(name:string): readonly [number, number] {
  name=canonicalIcon(name);
  if(name==="send"||name==="arrow-ur"||name==="external-link")return [1,-1];
  if(name==="download")return [0,1];
  if(name==="upload")return [0,-1];
  if(name==="arrow-r")return [1,0];
  if(name==="arrow-l")return [-1,0];
  const x=name.includes("left")?-1:name.includes("right")?1:0;
  const y=name.includes("up")?-1:name.includes("down")?1:0;
  return [x,y];
}
type IconPartMotion = {
  parts:"glyph"|number[];
  move?:[number,number]; scale?:[number,number]; pivot?:[number,number];
  rotate?:number; turn?:boolean; trace?:boolean; opacity?:number; delay?:number; waves?:number;
};
type IconRecipe = {description:string;motions:IconPartMotion[]};
// A compact authored vocabulary: travel, hinge, stretch, trace, and emphasis.
const iconRecipes:Record<string,IconRecipe> = {
  "party-popper":{"description":"Confetti spreads from the cone while its rim stays anchored.","motions":[{"parts":[1,7],"move":[-0.7,-1.5]},{"parts":[2,3,5],"move":[1,-1.5]},{"parts":[4,6],"move":[1.5,0.4]}]},
  "arrow-right":{"description":"The glyph travels in its drawn direction and returns.","motions":[{"parts":"glyph","move":[2.5,0.0]}]},
  "arrow-left":{"description":"The glyph travels in its drawn direction and returns.","motions":[{"parts":"glyph","move":[-2.5,0.0]}]},
  "arrow-up":{"description":"The glyph travels in its drawn direction and returns.","motions":[{"parts":"glyph","move":[0.0,-2.5]}]},
  "arrow-down":{"description":"The glyph travels in its drawn direction and returns.","motions":[{"parts":"glyph","move":[0.0,2.5]}]},
  "chevron-up":{"description":"The glyph travels in its drawn direction and returns.","motions":[{"parts":"glyph","move":[0.0,-2.5]}]},
  "chevron-down":{"description":"The glyph travels in its drawn direction and returns.","motions":[{"parts":"glyph","move":[0.0,2.5]}]},
  "chevron-left":{"description":"The glyph travels in its drawn direction and returns.","motions":[{"parts":"glyph","move":[-2.5,0.0]}]},
  "chevron-right":{"description":"The glyph travels in its drawn direction and returns.","motions":[{"parts":"glyph","move":[2.5,0.0]}]},
  "external-link":{"description":"The arrow exits upward-right while the window frame stays fixed.","motions":[{"parts":[0,1],"move":[1.8,-1.8]}]},
  "play":{"description":"The play triangle presses inward, then returns to its start position.","motions":[{"parts":"glyph","move":[1.4,0],"scale":[-0.07,-0.07]}]},
  "pause":{"description":"The two pause bars draw inward toward a held center.","motions":[{"parts":[0],"move":[-1.2,0]},{"parts":[1],"move":[1.2,0]}]},
  "skip-forward":{"description":"The triangle advances toward its stationary stop bar.","motions":[{"parts":[1],"move":[2,0]}]},
  "volume-2":{"description":"Sound waves expand outward from the stationary speaker.","motions":[{"parts":[1],"move":[1,0],"scale":[0,0.12],"pivot":[16,12]},{"parts":[2],"move":[1.5,0],"scale":[0,0.1],"pivot":[19,12],"delay":0.12}]},
  "volume-x":{"description":"The mute cross traces over a stationary speaker.","motions":[{"parts":[1],"trace":true},{"parts":[2],"trace":true,"delay":0.12}]},
  "mic":{"description":"The microphone capsule responds to a short voice beat above its fixed stand.","motions":[{"parts":[2],"scale":[0,-0.13],"pivot":[12,15],"waves":3}]},
  "video":{"description":"The lens wedge opens from the camera body.","motions":[{"parts":[0],"rotate":-9,"pivot":[16,12]}]},
  "camera":{"description":"The camera lens closes and reopens like a shutter.","motions":[{"parts":[1],"scale":[0,-0.82],"pivot":[12,13]}]},
  "image":{"description":"The landscape traces inside the fixed picture frame as its sun rises.","motions":[{"parts":[2],"trace":true},{"parts":[1],"move":[0,-1]}]},
  "menu":{"description":"Menu strokes slide outward in a short top-to-bottom sequence.","motions":[{"parts":[0],"move":[-1.5,0]},{"parts":[1],"move":[-1.5,0],"delay":0.09},{"parts":[2],"move":[-1.5,0],"delay":0.18}]},
  "ellipsis":{"description":"The three continuation dots lift left to right.","motions":[{"parts":[2],"move":[0,-1.5]},{"parts":[0],"move":[0,-1.5],"delay":0.1},{"parts":[1],"move":[0,-1.5],"delay":0.2}]},
  "maximize":{"description":"The four window corners expand outward and return.","motions":[{"parts":[0],"move":[-1,-1]},{"parts":[1],"move":[1,-1]},{"parts":[2],"move":[-1,1]},{"parts":[3],"move":[1,1]}]},
  "layout-grid":{"description":"Dashboard tiles settle into place in a clockwise sequence.","motions":[{"parts":[0],"scale":[-0.12,-0.12],"pivot":[6.5,6.5],"delay":0.0},{"parts":[1],"scale":[-0.12,-0.12],"pivot":[17.5,6.5],"delay":0.08},{"parts":[2],"scale":[-0.12,-0.12],"pivot":[17.5,17.5],"delay":0.16},{"parts":[3],"scale":[-0.12,-0.12],"pivot":[6.5,17.5],"delay":0.24}]},
  "pencil":{"description":"The pencil writes a small stroke around its tip.","motions":[{"parts":"glyph","rotate":7,"pivot":[3,21],"waves":3}]},
  "share-2":{"description":"Connections trace toward the two receiving nodes.","motions":[{"parts":[3],"trace":true},{"parts":[0],"scale":[0.13,0.13],"pivot":[18,5],"delay":0.12},{"parts":[2],"scale":[0.13,0.13],"pivot":[18,19],"delay":0.2}]},
  "filter":{"description":"The funnel compresses toward its narrow outlet.","motions":[{"parts":"glyph","scale":[-0.09,-0.08],"pivot":[12,20]}]},
  "eye":{"description":"The eyelid closes briefly over a pupil that refocuses.","motions":[{"parts":[0],"scale":[0,-0.7]},{"parts":[1],"scale":[0,-0.7]}]},
  "eye-off":{"description":"The diagonal concealment stroke traces across the stationary eye.","motions":[{"parts":[3],"trace":true}]},
  "rocket":{"description":"The rocket travels along its nose direction while its exhaust extends.","motions":[{"parts":"glyph","move":[1.4,-1.4]},{"parts":[3],"scale":[0.16,0.16],"pivot":[4,20]}]},
  "save":{"description":"The disk label writes from left to right inside the stationary case.","motions":[{"parts":[2],"trace":true}]},
  "link":{"description":"The two chain links draw apart along their axis and reconnect.","motions":[{"parts":[0],"move":[1,-1]},{"parts":[1],"move":[-1,1]}]},
  "bookmark":{"description":"The bookmark slides down into its reading position.","motions":[{"parts":"glyph","move":[0,1.5]}]},
  "lock":{"description":"The shackle lifts above the fixed lock body and closes.","motions":[{"parts":[1],"move":[0,-1.2]}]},
  "key":{"description":"The key turns around its shaft tip, then returns.","motions":[{"parts":"glyph","rotate":15,"pivot":[21,2]}]},
  "log-out":{"description":"The arrow leaves through the stationary doorway.","motions":[{"parts":[0,1],"move":[2,0]}]},
  "mail":{"description":"The envelope flap lifts from its hinge above a fixed body.","motions":[{"parts":[1],"scale":[0,-0.4],"pivot":[12,6]}]},
  "message-circle":{"description":"The message bubble grows gently from its anchored tail.","motions":[{"parts":"glyph","scale":[0.08,0.08],"pivot":[3,21]}]},
  "phone":{"description":"The receiver rings with a damped turn around its center.","motions":[{"parts":"glyph","rotate":9,"waves":5}]},
  "at-sign":{"description":"The mention tail traces around its stationary center.","motions":[{"parts":[1],"trace":true}]},
  "inbox":{"description":"The inbox lip dips as an item arrives, with the outer tray fixed.","motions":[{"parts":[0],"move":[0,0.8]}]},
  "shield":{"description":"The shield braces wider around its guarded center.","motions":[{"parts":"glyph","scale":[0.07,-0.03]}]},
  "circle-help":{"description":"The question mark tilts above its dot while the enclosing ring stays fixed.","motions":[{"parts":[0],"rotate":-10,"pivot":[12,14]}]},
  "circle-plus":{"description":"The plus strokes trace inside the stationary ring.","motions":[{"parts":[1],"trace":true},{"parts":[2],"trace":true,"delay":0.12}]},
  "x-circle":{"description":"The dismissal cross traces inside the stationary ring.","motions":[{"parts":[1],"trace":true},{"parts":[2],"trace":true,"delay":0.12}]},
  "calendar":{"description":"The binder rings press into the stationary calendar page.","motions":[{"parts":[0],"move":[0,1]},{"parts":[1],"move":[0,1],"delay":0.12}]},
  "clock":{"description":"The hands complete one sweep inside the stationary clock face.","motions":[{"parts":[1],"rotate":360,"turn":true}]},
  "timer":{"description":"The start button dips, then the hand sweeps inside the fixed dial.","motions":[{"parts":[0],"move":[0,0.7]},{"parts":[1],"rotate":360,"turn":true,"pivot":[12,14]}]},
  "house":{"description":"The doorway opens around its left hinge inside the fixed house.","motions":[{"parts":[0],"scale":[-0.25,0],"pivot":[9,21]}]},
  "folder":{"description":"The folder tips open around its bottom edge and settles.","motions":[{"parts":"glyph","scale":[0,-0.1],"pivot":[12,20]}]},
  "file-text":{"description":"Text strokes write line by line inside the fixed document.","motions":[{"parts":[2],"trace":true},{"parts":[3],"trace":true,"delay":0.1},{"parts":[4],"trace":true,"delay":0.2}]},
  "code":{"description":"The brackets separate around a stationary slash.","motions":[{"parts":[0],"move":[-1.4,0]},{"parts":[1],"move":[1.4,0]}]},
  "target":{"description":"The bullseye contracts toward its exact center within stationary outer rings.","motions":[{"parts":[2],"scale":[-0.3,-0.3]}]},
  "terminal":{"description":"The prompt advances as the cursor briefly dims and returns.","motions":[{"parts":[1],"move":[1,0]},{"parts":[0],"opacity":-0.65}]},
  "database":{"description":"The top disk compresses as a write settles through the data stack.","motions":[{"parts":[0],"scale":[0,-0.16],"pivot":[12,5]},{"parts":[2],"move":[0,0.8],"delay":0.14}]},
  "cloud":{"description":"The cloud drifts upward and returns without rotating.","motions":[{"parts":"glyph","move":[0.5,-1.4]}]},
  "globe":{"description":"The meridian turns across a stationary globe outline and equator.","motions":[{"parts":[2],"scale":[-0.75,0]}]},
  "monitor":{"description":"The display compresses and reopens above its stationary stand.","motions":[{"parts":[0],"scale":[0,-0.28],"pivot":[12,10]}]},
  "smartphone":{"description":"The phone gives a small lateral notification vibration.","motions":[{"parts":"glyph","move":[0.75,0],"waves":5}]},
  "sun":{"description":"The rays fan outward from the stationary sun core.","motions":[{"parts":[1],"move":[0,-0.8],"delay":0.025},{"parts":[2],"move":[0,0.8],"delay":0.05},{"parts":[3],"move":[-0.6,-0.6],"delay":0.07500000000000001},{"parts":[4],"move":[0.6,0.6],"delay":0.1},{"parts":[5],"move":[-0.8,0],"delay":0.125},{"parts":[6],"move":[0.8,0],"delay":0.15000000000000002},{"parts":[7],"move":[-0.6,0.6],"delay":0.17500000000000002},{"parts":[8],"move":[0.6,-0.6],"delay":0.2}]},
  "moon":{"description":"The crescent rocks gently around its lower tip.","motions":[{"parts":"glyph","rotate":-7,"pivot":[7,19]}]},
  "shopping-cart":{"description":"The cart rolls forward, with its wheels settling at the end.","motions":[{"parts":"glyph","move":[1.6,0]},{"parts":[0],"move":[0,-0.5],"delay":0.18},{"parts":[1],"move":[0,-0.5],"delay":0.24}]},
  "credit-card":{"description":"The payment stripe traces across a stationary card.","motions":[{"parts":[1],"trace":true}]},
  "crown":{"description":"The crown descends toward its stationary lower band.","motions":[{"parts":[0],"move":[0,1.2]}]},
  "dollar-sign":{"description":"The currency stroke traces around the stationary vertical bar.","motions":[{"parts":[1],"trace":true}]},
  "tag":{"description":"The tag swings from its punched hole.","motions":[{"parts":"glyph","rotate":12,"pivot":[7.5,7.5]}]},
  "package":{"description":"The tape seam draws across the closed package.","motions":[{"parts":[3],"trace":true}]},
  "gem":{"description":"Interior facets catch light in sequence inside the fixed stone outline.","motions":[{"parts":[0],"opacity":-0.55},{"parts":[2],"opacity":-0.55,"delay":0.16}]},
  "gift":{"description":"The lid and bow lift together above a stationary gift box.","motions":[{"parts":[2,3],"move":[0,-1.5]}]},
  "wallet":{"description":"The wallet expands slightly from its spine as it fills.","motions":[{"parts":"glyph","scale":[0.07,0],"pivot":[3,12]}]},
  "award":{"description":"The ribbon unfurls beneath a stationary medal.","motions":[{"parts":[0],"scale":[0,-0.25],"pivot":[12,13]}]},
  "bar-chart-3":{"description":"Bars grow from a fixed baseline in a left-to-right sequence.","motions":[{"parts":[1],"scale":[0,-0.25],"pivot":[7,16]},{"parts":[2],"scale":[0,-0.25],"pivot":[12,16],"delay":0.1},{"parts":[3],"scale":[0,-0.25],"pivot":[17,16],"delay":0.2}]},
  "trending-down":{"description":"The descending trend traces toward its lower-right arrowhead.","motions":[{"parts":[1],"trace":true},{"parts":[0],"move":[0.7,0.7],"delay":0.12}]},
  "trending-up":{"description":"The rising trend traces toward its upper-right arrowhead.","motions":[{"parts":[1],"trace":true},{"parts":[0],"move":[0.7,-0.7],"delay":0.12}]},
  "trophy":{"description":"The cup and handles lift above the trophy base.","motions":[{"parts":[2,4,5],"move":[0,-1.1]}]},
  "user":{"description":"The user nods with a small head dip above fixed shoulders.","motions":[{"parts":[1],"move":[0,0.8]}]},
  "users":{"description":"The second figure steps outward from the fixed foreground figure.","motions":[{"parts":[1,2],"move":[1,0]}]},
  "user-plus":{"description":"The add-member cross traces beside a stationary person.","motions":[{"parts":[2],"trace":true},{"parts":[3],"trace":true,"delay":0.12}]},
  "sparkles":{"description":"The accent sparkles twinkle around the main star in sequence.","motions":[{"parts":[1,2],"scale":[0.2,0.2],"pivot":[20,4]},{"parts":[3],"scale":[0.18,0.18],"pivot":[4,20],"delay":0.18}]},
  "zap":{"description":"The bolt traces quickly along its zigzag, then holds its complete outline.","motions":[{"parts":[0],"trace":true}]},
  "flame":{"description":"The flame stretches from its anchored base in a restrained heat pulse.","motions":[{"parts":"glyph","scale":[-0.04,0.1],"pivot":[12,22],"waves":3}]}
};
function recipeFrame(recipe:IconRecipe,p:number,amount:number):IconMotionFrame {
  const frame:IconMotionFrame={};
  for(const motion of recipe.motions) {
    const delay=motion.delay??0;
    const t=Math.max(0,Math.min(1,(p-delay)/(1-delay)));
    const pulse=(motion.waves?Math.sin(Math.PI*t*motion.waves)*(1-t):Math.sin(Math.PI*t))*amount;
    const [cx,cy]=motion.pivot??[12,12];
    const transform:string[]=[];
    if(motion.move)transform.push(`translate(${motion.move[0]*pulse} ${motion.move[1]*pulse})`);
    if(motion.rotate)transform.push(`rotate(${motion.rotate*(motion.turn?t:pulse)} ${cx} ${cy})`);
    if(motion.scale)transform.push(`translate(${cx} ${cy}) scale(${Math.max(.08,1+motion.scale[0]*pulse)} ${Math.max(.08,1+motion.scale[1]*pulse)}) translate(${-cx} ${-cy})`);
    for(const part of motion.parts==="glyph"?["glyph"]:motion.parts) {
      frame[part]={...(transform.length?{transform:transform.join(" ")}:{ }),...(motion.trace?{draw:Math.min(1,t*1.8)}:{}),...(motion.opacity!==undefined?{opacity:Math.max(.15,Math.min(1,1+motion.opacity*pulse))}:{})};
    }
  }
  return frame;
}
function hasIconMotion(name:string) { return isKnownIcon(name); }
type MotionFamily="direction"|"organic"|"communication"|"pulse"|"trace";
function motionFamily(name:string):MotionFamily {
  if(/^(arrow|chevron|move|corner|undo|redo|send|navigation)/.test(name)&&!/(up-down|left-right)/.test(name))return "direction";
  if(/^(leaf|flower|sprout|tree|feather|wind|cloud|bird|fish|flame|wheat|rainbow)/.test(name))return "organic";
  if(/^(message|mail|speech|contact|inbox)/.test(name))return "communication";
  if(/^(heart|audio|volume|radio|wifi|signal|radar|sun|sparkle)/.test(name))return "pulse";
  return "trace";
}
/** Families extend coverage without guessing which upstream path is a hinge or moving part. */
function familyRecipe(name:string):IconRecipe {
  const family=motionFamily(name);
  if(family==="direction"){
    const [x,y]=getIconDirection(name);
    if(x||y)return {description:"Travels in its drawn direction, then settles back.",motions:[{parts:"glyph",move:[2*x,2*y]}]};
  }
  if(family==="organic")return {description:"Sways gently from its base and settles, like a living stem.",motions:[{parts:"glyph",rotate:5,pivot:[12,21],scale:[-.025,.04]}]};
  if(family==="communication")return {description:"Opens gently from the lower edge, then settles into place.",motions:[{parts:"glyph",scale:[.07,.1],pivot:[6,20]}]};
  if(family==="pulse")return {description:"Gives a short, damped signal pulse and returns to rest.",motions:[{parts:"glyph",scale:[.11,.11],waves:3}]};
  return {description:"Strokes draw in a short sequence, then hold their complete silhouette.",motions:(iconGeometry(name)??[]).map((_,index)=>({parts:[index],trace:true,delay:Math.min(index*.035,.24)}))};
}
type IconMotionFrame = Record<string,{transform?:string;draw?:number;opacity?:number}>;
/** Original motion in the pack's 24-unit coordinate space. Keys identify owned SVG groups. */
function getIconMotionFrame(name:string,progress:number,amplitude=1):IconMotionFrame {
  name=canonicalIcon(name);
  const p=Number.isFinite(progress)?Math.max(0,Math.min(1,progress)):1;
  const amount=Number.isFinite(amplitude)?Math.max(0,Math.min(3,amplitude)):1;
  if(!amount)return {};
  if(iconRecipes[name])return recipeFrame(iconRecipes[name],p,amount);
  const pulse=Math.sin(Math.PI*p)*amount;
  const scale=(value:number)=>`translate(12 12) scale(${value}) translate(-12 -12)`;
  const move=(x:number,y:number)=>({transform:`translate(${x} ${y})`});
  switch(name) {
    case "check": return {0:{draw:Math.min(1,p*1.8)}};
    case "circle-check": return {1:{draw:Math.min(1,p*1.8)}};
    case "circle-check-big": return {1:{draw:Math.min(1,p*1.8)}};
    case "activity": return {0:{draw:Math.min(1,p*1.5)}};
    case "x": return {glyph:{transform:scale(1-.12*pulse)}};
    case "alert-triangle": case "alert-circle": return {1:move(0,-1.2*pulse)};
    case "triangle-alert": case "circle-alert":
      return {1:move(0,-1.2*pulse),2:move(0,-.5*pulse)};
    case "info": return {2:move(0,-1.5*pulse)};
    case "loader-circle": case "refresh-cw": return {glyph:{transform:`rotate(${360*p} 12 12)`}};
    case "search": return {1:{transform:`translate(11 11) scale(${1+.07*pulse}) translate(-11 -11)`}};
    case "bell": {
      const swing=Math.sin(4*Math.PI*p)*(1-p)*amount;
      return {0:move(-1.8*swing,0),1:{transform:`rotate(${12*swing} 12 3)`}};
    }
    case "download": return {0:move(0,2*pulse),2:move(0,2*pulse)};
    case "upload": return {0:move(0,-2*pulse),1:move(0,-2*pulse)};
    case "copy": return {0:move(1.2*pulse,1.2*pulse)};
    case "settings": return {0:{transform:`rotate(${60*p} 12 12)`}};
    case "trash-2": {
      const lid={transform:`translate(0 ${-1.5*pulse}) rotate(${-12*pulse} 6 6)`};
      return {3:lid,4:lid};
    }
    case "plus": return {glyph:{transform:`rotate(${90*p} 12 12)`}};
    case "heart": {
      const beat=Math.pow(Math.sin(2*Math.PI*p),2)*Math.sin(Math.PI*p)*amount;
      return {glyph:{transform:scale(1+.13*beat)}};
    }
    case "star": return {glyph:{transform:scale(1+.12*pulse)}};
    case "thumbs-up": return {0:move(0,-1.4*pulse)};
    default:return recipeFrame(familyRecipe(name),p,amount);
  }
}
/** The painter owns only generated groups, never the consumer's SVG transforms or styles. */
function createIconMotionPainter(svg:SVGSVGElement,name:string,amplitude=1,frames?:(progress:number)=>IconMotionFrame) {
  const groups=new Map(Array.from(svg.querySelectorAll<SVGGElement>("[data-icon-part]")).map(group=>[group.dataset.iconPart!,group]));
  const backdrop=svg.querySelector("[data-icon-backdrop]");
  const written=new Map<Element,Map<string,{before:string|null;value:string}>>();
  const lengths=new Map<SVGGeometryElement,number>();
  const set=(node:Element,attribute:string,value:string)=>{
    let attributes=written.get(node);
    if(!attributes){attributes=new Map();written.set(node,attributes)}
    const previous=attributes.get(attribute);
    // Yield this attribute if a consumer takes ownership during an animation.
    if(previous&&node.getAttribute(attribute)!==previous.value)return;
    attributes.set(attribute,{before:previous?previous.before:node.getAttribute(attribute),value});
    node.setAttribute(attribute,value);
  };
  return {
    paint(progress:number) {
      for(const path of svg.querySelectorAll<SVGPathElement>("path[data-icon-organic-line]")){
        const source=path.dataset.iconOrganicSource;
        if(source){const pulse=Math.sin(Math.PI*Math.max(0,Math.min(1,progress)))*Math.max(0,Math.min(3,amplitude));set(path,"d",organicMotionPath(source,pulse*.18));}
      }
      if(backdrop){
        const p=Number.isFinite(progress)?Math.max(0,Math.min(1,progress)):1;
        const pulse=Math.sin(Math.PI*p)*(Number.isFinite(amplitude)?Math.max(0,Math.min(3,amplitude)):1);
        set(backdrop,"transform",`translate(12 12) rotate(${4*pulse}) scale(${1+.035*pulse} ${1-.025*pulse}) translate(-12 -12)`);
      }
      for(const [part,frame] of Object.entries(frames?frames(progress):getIconMotionFrame(name,progress,amplitude))) {
        const group=groups.get(part);if(!group)continue;
        if(frame.transform)set(group,"transform",frame.transform);
        if(frame.opacity!==undefined)set(group,"opacity",String(frame.opacity));
        if(frame.draw!==undefined)for(const path of group.querySelectorAll<SVGGeometryElement>("path,line,polyline,polygon,rect,circle,ellipse")) {
          const length=lengths.get(path)??path.getTotalLength();lengths.set(path,length);
          set(path,"stroke-dasharray",`${length} ${length}`);
          set(path,"stroke-dashoffset",String(length*(1-frame.draw)));
        }
      }
    },
    restore() {
      for(const [node,attributes] of written)for(const [attribute,{before,value}] of attributes) {
        if(node.getAttribute(attribute)!==value)continue;
        if(before===null)node.removeAttribute(attribute);else node.setAttribute(attribute,before);
      }
      written.clear();
    },
  };
}
function organicPath(d:string,bend:number){
  const horizontal=/^M\s*([\d.-]+)\s+([\d.-]+)h\s*([\d.-]+)$/.exec(d);
  if(horizontal){const [,x,y,width]=horizontal;const end=Number(x)+Number(width);return `M${x} ${y} Q${(Number(x)+end)/2} ${(Number(y)-bend).toFixed(3)} ${end} ${y}`}
  const vertical=/^M\s*([\d.-]+)\s+([\d.-]+)v\s*([\d.-]+)$/.exec(d);
  if(vertical){const [,x,y,height]=vertical;const end=Number(y)+Number(height);return `M${x} ${y} Q${(Number(x)+bend).toFixed(3)} ${(Number(y)+end)/2} ${x} ${end}`}
  return d;
}
function organicMotionPath(d:string,amount:number){
  if(!amount||/[aA]/.test(d))return d;let index=0;
  return d.replace(/-?\d*\.?\d+/g,value=>{index++;const delta=index%5===0?amount:index%7===0?-amount*.6:0;return delta?(Number(value)+delta).toFixed(3).replace(/\.?(?:0+)$/," ").trim():value});
}
function renderNode(node:IconNode,key:number,organic=false):React.ReactNode{
  const attrs={...node.attrs,key};
  if(organic&&node.tag==="path"&&typeof node.attrs.d==="string")return React.createElement("path",{...attrs,d:organicPath(node.attrs.d,.32),"data-icon-organic-line":"","data-icon-organic-rest":organicPath(node.attrs.d,.32),"data-icon-organic-source":node.attrs.d},...node.children.map((child,index)=>renderNode(child,index,organic)));
  return React.createElement(node.tag,attrs,...node.children.map((child,index)=>renderNode(child,index,organic)))
}
type IconProps=React.ComponentProps<"svg"> & {
  name:string;
  size?:"default"|"sm"|"lg";
  draw?:boolean;
  /** One-shot feedback from the nearest control. Disable when another owner animates this icon. */
  feedback?:boolean;
  /** Optional Cojeev treatments; outline preserves the original glyph footprint. */
  treatment?:"outline"|"duotone"|"organic";
  /** Accent layer color. Outline remains currentColor for readable action icons. */
  tone?:"current"|"pink"|"blue"|"olive"|"yellow";
  /** Bounded timing for native control feedback; AnimatedIcon adds explicit preset motion. */
  feedbackDuration?:number;
  feedbackEase?:"gentle"|"settle"|"linear"|readonly [number,number,number,number];
}
const iconControlSelector = 'button,a[href],summary,[role="button"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"],[role="tab"],[role="checkbox"],[role="radio"],[role="switch"],label';
function useIconFeedback(host:React.RefObject<SVGSVGElement|null>, enabled:boolean, name:string,duration?:number,ease:IconProps["feedbackEase"]="gentle") {
  React.useEffect(() => {
    const svg=host.current;
    const control=svg?.closest<HTMLElement>(iconControlSelector);
    if(!enabled||!svg||!control)return;
    const semantic=hasIconMotion(name)?createIconMotionPainter(svg,name):null;
    let inView=false;
    let active=false;
    let kind:"hover"|"focus"|"press"="hover";
    let baseScale="none",baseRotate="none";
    let pendingKeyClick=false;
    let keyRelease:ReturnType<typeof setTimeout>|undefined;
    const original=new Map<string,{value:string;priority:string}>();
    const written=new Map<string,{value:string;priority:string}>();
    const owns=(property:string,value:{value:string;priority:string})=>svg.style.getPropertyValue(property)===value.value&&svg.style.getPropertyPriority(property)===value.priority;
    const paint=(property:string,value:string)=>{
      if(!original.has(property))original.set(property,{value:svg.style.getPropertyValue(property),priority:svg.style.getPropertyPriority(property)});
      svg.style.setProperty(property,value);written.set(property,{value:svg.style.getPropertyValue(property),priority:svg.style.getPropertyPriority(property)});
    };
    const restore=()=>{
      for(const [property,previous] of original) {
        // A consumer can change its inline style during feedback; never restore over that update.
        const current=written.get(property);
        if(!current||!owns(property,current))continue;
        if(previous.value)svg.style.setProperty(property,previous.value,previous.priority);
        else svg.style.removeProperty(property);
      }
      original.clear();written.clear();semantic?.restore();active=false;delete svg.dataset.iconFeedback;
    };
    const lane=createMotionLane(0,progress=>{
      if(!active)return;
      if(semantic){semantic.paint(progress);return}
      // Yield the whole effect before another frame can overwrite a consumer update.
      if([...written].some(([property,value])=>!owns(property,value))){stop();return}
      const pulse=Math.sin(Math.PI*Math.max(0,Math.min(1,progress)));
      const scale=1+pulse*(kind==="press"?-.09:.06);
      const rotate=0;
      // Individual CSS transforms compose with the consumer's transform attribute/style.
      paint("scale",baseScale==="none"?String(scale):baseScale.split(/\s+/).map(value=>`calc(${value} * ${scale})`).join(" "));
      // Preserve a consumer's 3D-axis rotation instead of trying to parse it as a 2D angle.
      if(!baseRotate.includes(" "))paint("rotate",`calc(${baseRotate==="none"?"0deg":baseRotate} + ${rotate}deg)`);
    });
    const stop=()=>{lane.stop();restore()};
    const eligible=()=>{
      const associated=control instanceof HTMLLabelElement?control.control:control;
      return inView&&!document.hidden&&!svg.closest('[inert],[hidden],[data-motion="off"],[data-flow="off"]')&&
        !associated?.matches(':disabled,[disabled],[aria-disabled="true"],[data-disabled]:not([data-disabled="false"])')&&
        !control.matches('[aria-disabled="true"],[data-disabled]:not([data-disabled="false"])')&&
        svg.getClientRects().length>0&&getComputedStyle(svg).visibility!=="hidden";
    };
    const start=(next:typeof kind)=>{
      if(!eligible()){stop();return}
      stop();kind=next;
      const computed=getComputedStyle(svg);baseScale=computed.scale;baseRotate=computed.rotate;
      active=true;svg.dataset.iconFeedback=kind;
      const seconds=duration!==undefined&&Number.isFinite(duration)?Math.max(.08,Math.min(duration,10)):next==="press"?.48:.62;
      const timing=ease==="gentle"?[.22,.72,.22,1] as const:ease==="settle"?[...motionTokens.ease.settle] as const:ease??"linear";
      lane.jump(0);lane.to(1,{duration:seconds,ease:timing},restore);
    };
    const enter=(event:PointerEvent)=>{if(event.pointerType!=="touch")start("hover")};
    const leave=()=>stop();
    const focus=()=>start("focus");
    const blur=(event:FocusEvent)=>{if(!control.contains(event.relatedTarget as Node|null))stop()};
    const key=(event:KeyboardEvent)=>{if(!event.repeat&&(event.key==="Enter"||event.key===" ")){clearTimeout(keyRelease);pendingKeyClick=true;start("press")}};
    const keyup=(event:KeyboardEvent)=>{if(event.key==="Enter"||event.key===" ")keyRelease=setTimeout(()=>{pendingKeyClick=false},0)};
    const click=()=>{if(pendingKeyClick){pendingKeyClick=false;clearTimeout(keyRelease);return}start("press")};
    const visibility=()=>{if(document.hidden)stop()};
    control.addEventListener("pointerenter",enter);control.addEventListener("pointerleave",leave);
    control.addEventListener("focusin",focus);control.addEventListener("focusout",blur);
    control.addEventListener("keydown",key);control.addEventListener("keyup",keyup);control.addEventListener("click",click);
    document.addEventListener("visibilitychange",visibility);
    const intersection=new IntersectionObserver(([entry])=>{inView=entry.isIntersecting;if(!inView)stop()},{threshold:.1});
    intersection.observe(svg);
    const attributes=new MutationObserver(()=>{if(active&&!eligible())stop()});
    for(let ancestor:Element|null=control;ancestor;ancestor=ancestor.parentElement)attributes.observe(ancestor,{attributes:true,attributeFilter:["disabled","aria-disabled","data-disabled","inert","hidden","data-motion","data-flow"]});
    if(control instanceof HTMLLabelElement&&control.control)attributes.observe(control.control,{attributes:true,attributeFilter:["disabled","aria-disabled","data-disabled"]});
    return ()=>{
      control.removeEventListener("pointerenter",enter);control.removeEventListener("pointerleave",leave);
      control.removeEventListener("focusin",focus);control.removeEventListener("focusout",blur);
      control.removeEventListener("keydown",key);control.removeEventListener("keyup",keyup);control.removeEventListener("click",click);clearTimeout(keyRelease);
      document.removeEventListener("visibilitychange",visibility);intersection.disconnect();attributes.disconnect();lane.dispose();restore();
    };
  },[host,enabled,name,duration,ease]);
}
function iconClassName(size:IconProps["size"]="default",className?:string){return cn("v-icon [width:var(--icon-md)] [height:var(--icon-md)] [stroke:currentColor] [stroke-width:var(--icon-stroke)] [stroke-linecap:round] [stroke-linejoin:round] [fill:none] [flex:none]",size!=="default"&&`-${size}`,className)}
function Icon({name,size="default",className,draw,feedback=true,treatment="outline",tone="current",feedbackDuration,feedbackEase,style,strokeWidth,ref,...props}:IconProps){
  const {quiet}=useChoreography();
  const host=React.useRef<SVGSVGElement|null>(null);
  const attach=React.useCallback((node:SVGSVGElement|null)=>{host.current=node;const release=assignMotionRef(ref,node);return()=>{host.current=null;release()}},[ref]);
  const geometry=useIconGeometry(name);
  // Motion painters index the drawn parts, so they wait for lazily loaded geometry.
  const drawn=geometry!==undefined;
  useIconFeedback(host,feedback&&!quiet&&draw===undefined&&drawn,name,feedbackDuration,feedbackEase);
  React.useEffect(()=>{
    if(!draw||quiet||!drawn||!host.current)return;
    const painter=createIconMotionPainter(host.current,name,1,p=>({glyph:{draw:p}}));
    const lane=createMotionLane(0,painter.paint);
    lane.jump(0);lane.to(1,{duration:.5,ease:[.2,.8,.2,1]},painter.restore);
    return()=>{lane.dispose();painter.restore()};
  },[draw,quiet,name,drawn]);
  const resolved=canonicalIcon(name);
  if(!geometry&&!isKnownIcon(name))throw new Error(`Unknown Cojeev icon: ${name}`);
  const nodes=geometry??[];
  const accent=tone==="current"?"currentColor":`var(--v-${tone})`;
  return <svg ref={attach} data-slot="icon" data-icon-name={name} data-icon-treatment={treatment} viewBox="0 0 24 24" aria-hidden="true" className={iconClassName(size,className)} style={{...(strokeWidth!==undefined?{strokeWidth}:{}),...style}} {...props}>
    <g data-icon-ink="" style={treatment==="organic"&&tone!=="current"?{color:accent}:undefined}>
      <g data-icon-part="glyph">{(treatment==="organic"?(organicIconGeometry[resolved]??nodes):nodes).map((node,index)=><g key={index} data-icon-part={index}>
        {treatment==="duotone"&&React.createElement(node.tag,{...node.attrs,"data-icon-accent":"",style:{stroke:accent,strokeWidth:4.5,fill:node.tag==="circle"||node.tag==="rect"||node.tag==="ellipse"||node.tag==="polygon"||/[zZ]\s*$/.test(node.attrs.d??"")?accent:"none",opacity:.22}})}
        {renderNode(node,index,treatment==="organic")}
      </g>)}</g>
    </g>
  </svg>
}

// ---- registry/cojeev/motion/use-motion-visibility.ts (inlined) ----
function subscribePreferences(listener: () => void) {
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  media.addEventListener("change", listener);
  document.addEventListener("visibilitychange", listener);
  return () => {
    media.removeEventListener("change", listener);
    document.removeEventListener("visibilitychange", listener);
  };
}
function readPreferences() {
  return document.visibilityState === "visible" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
/** A shared stillness boundary for optional landing-page effects. */
function useMotionVisibility(ref: React.RefObject<Element | null>, mountedElement?: Element | null) {
  const { motion, flow } = React.useSyncExternalStore(subscribeSettings, getSettingsSnapshot, getServerSettingsSnapshot);
  const permitted = React.useSyncExternalStore(subscribePreferences, readPreferences, () => false);
  const [inView, setInView] = React.useState(false);
  React.useEffect(() => {
    const element = mountedElement ?? ref.current;
    if (!element) { setInView(false); return; }
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), { threshold: 0.1 });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, mountedElement]);
  return { enabled: permitted && motion.mode !== "off" && flow.variant !== "off", inView };
}

// ---- registry/cojeev/ui/animated-icon.tsx ----
export type IconMotion = "auto" | "tremor" | "draw" | "spin" | "bounce" | "validation" | "pulse" | "none";
export type IconMotionEase="gentle"|"settle"|"linear"|readonly [number,number,number,number];
export type AnimatedIconProps = Omit<IconProps,"draw"|"feedback"> & { preset?:IconMotion; active?:boolean; amplitude?:number; duration?:number; ease?:IconMotionEase };
function AnimatedIconImpl({name,preset="auto",active,amplitude=1,duration,ease="gentle",className,size="default",children,...props}:AnimatedIconProps) {
  const host=React.useRef<HTMLSpanElement>(null);
  const {quiet}=useChoreography();
  const {enabled,inView}=useMotionVisibility(host);
  const [hovered,setHovered]=React.useState(false);
  const [focused,setFocused]=React.useState(false);
  const [allowed,setAllowed]=React.useState(false);
  const [replay,setReplay]=React.useState(0);
  const [replayActive,setReplayActive]=React.useState(false);
  const seconds=duration!==undefined&&Number.isFinite(duration)?Math.max(.08,Math.min(duration,10)):undefined;
  React.useEffect(()=>{
    if(!replayActive)return;
    const timer=setTimeout(()=>setReplayActive(false),(seconds??.55)*1000);
    return()=>clearTimeout(timer);
  },[replay,replayActive,seconds]);
  React.useEffect(()=>{
    const node=host.current?.closest<HTMLElement>('button,a[href],summary,[role=button],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option],[role=tab],[role=checkbox],[role=radio],[role=switch],label')??host.current;
    if(!node)return;
    const associated=node instanceof HTMLLabelElement?node.control:node;
    const eligible=()=>!node.closest('[inert],[hidden],[data-motion="off"],[data-flow="off"]')&&!node.matches(':disabled,[disabled],[aria-disabled="true"],[data-disabled]:not([data-disabled="false"])')&&!associated?.matches(':disabled,[disabled],[aria-disabled="true"],[data-disabled]:not([data-disabled="false"])');
    const sync=()=>{const next=eligible();setAllowed(next);if(!next){setHovered(false);setFocused(false);setReplayActive(false)}};
    sync();
    const startReplay=()=>{
      if(!eligible())return;
      setReplay(value=>value+1);setReplayActive(true);
    };
    const enter=(event:PointerEvent)=>{if(event.pointerType!=="touch")setHovered(eligible())},leave=()=>setHovered(false);
    const focus=()=>setFocused(eligible()),blur=(event:FocusEvent)=>{if(!node.contains(event.relatedTarget as Node|null))setFocused(false)};
    let pendingClick:"pointer"|"keyboard"|null=null;
    let releaseTimer:ReturnType<typeof setTimeout>|null=null;
    const queueRelease=()=>{if(releaseTimer!==null)clearTimeout(releaseTimer);releaseTimer=setTimeout(()=>{pendingClick=null;releaseTimer=null},0)};
    const pointerdown=(event:PointerEvent)=>{if(event.button!==0)return;if(releaseTimer!==null)clearTimeout(releaseTimer);pendingClick="pointer";startReplay()};
    const pointerup=()=>{if(pendingClick==="pointer")queueRelease()};
    const pointercancel=()=>{if(pendingClick==="pointer")pendingClick=null};
    const keydown=(event:KeyboardEvent)=>{if(event.repeat||!(event.key==="Enter"||event.key===" "))return;if(releaseTimer!==null)clearTimeout(releaseTimer);pendingClick="keyboard";startReplay()};
    const keyup=(event:KeyboardEvent)=>{if((event.key==="Enter"||event.key===" ")&&pendingClick==="keyboard")queueRelease()};
    const click=()=>{if(pendingClick){pendingClick=null;if(releaseTimer!==null){clearTimeout(releaseTimer);releaseTimer=null}return}startReplay()};
    node.addEventListener("pointerenter",enter);node.addEventListener("pointerleave",leave);node.addEventListener("focusin",focus);node.addEventListener("focusout",blur);node.addEventListener("pointerdown",pointerdown);node.addEventListener("keydown",keydown);node.addEventListener("keyup",keyup);node.addEventListener("click",click);
    window.addEventListener("pointerup",pointerup);window.addEventListener("pointercancel",pointercancel);window.addEventListener("blur",queueRelease);
    const attributes=new MutationObserver(sync);
    const observe=(element:Element)=>attributes.observe(element,{attributes:true,attributeFilter:["disabled","aria-disabled","data-disabled","inert","hidden","data-motion","data-flow"]});
    for(let ancestor:Element|null=node;ancestor;ancestor=ancestor.parentElement)observe(ancestor);
    if(associated&&associated!==node)observe(associated);
    return ()=>{node.removeEventListener("pointerenter",enter);node.removeEventListener("pointerleave",leave);node.removeEventListener("focusin",focus);node.removeEventListener("focusout",blur);node.removeEventListener("pointerdown",pointerdown);node.removeEventListener("keydown",keydown);node.removeEventListener("keyup",keyup);node.removeEventListener("click",click);window.removeEventListener("pointerup",pointerup);window.removeEventListener("pointercancel",pointercancel);window.removeEventListener("blur",queueRelease);if(releaseTimer!==null)clearTimeout(releaseTimer);attributes.disconnect()};
  },[]);
  const amount=Number.isFinite(amplitude)?Math.max(0,Math.min(amplitude,3)):1;
  const permitted=allowed&&!quiet&&enabled&&inView&&amount>0;
  const running=permitted&&(active??(hovered||focused||replayActive));
  const intent=preset!=="auto"?preset:"semantic";
  React.useEffect(()=>{
    if(intent==="none"||!running)return;
    const svg=host.current?.querySelector<SVGSVGElement>("[data-slot=icon]");if(!svg)return;
    const direction=getIconDirection(name);
    const [dx,dy]=direction[0]||direction[1]?direction:[1,0];
    const painter=createIconMotionPainter(svg,name,amount,intent==="semantic"?undefined:p=>{
      const pulse=Math.sin(Math.PI*p)*amount;
      if(intent==="draw")return {glyph:{draw:p}};
      if(intent==="spin")return {glyph:{transform:`rotate(${360*p} 12 12)`}};
      if(intent==="tremor")return {glyph:{transform:`rotate(${Math.sin(p*Math.PI*5)*(1-p)*9*amount} 12 12)`}};
      if(intent==="bounce")return {glyph:{transform:`translate(${3*pulse*dx} ${3*pulse*dy})`}};
      const scale=intent==="validation"?1-.15*Math.sin(p*Math.PI*2)*(1-p)*amount:1+.12*pulse;
      return {glyph:{transform:`translate(12 12) scale(${scale}) translate(-12 -12)`}};
    });
    const lane=createMotionLane(0,painter.paint);
    const looping=intent==="spin"||(intent==="semantic"&&(name==="loader"||name==="loader-circle"));
    lane.jump(0);
    const timing=looping?"linear":ease==="gentle"?([.22,.72,.22,1] as const):ease==="settle"?([.2,.8,.2,1] as const):ease;
    lane.to(1,{duration:seconds??(looping?1.35:.55),ease:timing,repeat:looping?Infinity:0},painter.restore);
    return ()=>{lane.dispose();painter.restore()};
  },[intent,running,name,amount,seconds,ease,active,replay]);
  return <span ref={host} data-slot="animated-icon" data-preset={intent} data-icon-replay={replay||undefined} data-animated={(running&&intent!=="none")||undefined} className="v-animated-icon">
    <span><Icon name={name} size={size} className={className} {...props} feedbackDuration={duration} feedbackEase={ease} feedback={false}>{children}</Icon></span>
  </span>;
}
export function AnimatedIcon(props: AnimatedIconProps) {
  return <AnimatedIconImpl {...props} />;
}
export type StateChevronProps = Omit<React.ComponentProps<"span">,"children"> & {
  /** Omit to follow the closest native trigger's data-state/aria-expanded. */
  open?: boolean;
  direction?: "down" | "right";
};
/** One real state cue; quiet motion still updates the direction immediately. */
function StateChevronImpl({ open, direction="down", className, ref, ...props }: StateChevronProps) {
  const host = React.useRef<HTMLSpanElement | null>(null);
  const [nativeOpen, setNativeOpen] = React.useState(false);
  const { quiet, transition } = useChoreography();
  const attach = React.useCallback((node: HTMLSpanElement | null) => {
    host.current = node;
    if (typeof ref === "function") return ref(node);
    if (ref) ref.current = node;
  }, [ref]);
  React.useEffect(() => {
    if (open !== undefined) return;
    const trigger = host.current?.parentElement?.closest("[aria-expanded],[data-state]");
    if (!trigger) return;
    const sync = () => setNativeOpen(trigger.getAttribute("aria-expanded") === "true" || trigger.getAttribute("data-state") === "open");
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(trigger, { attributes:true, attributeFilter:["data-state","aria-expanded"] });
    return () => observer.disconnect();
  }, [open]);
  const expanded = open ?? nativeOpen;
  return <span {...props} ref={attach} data-slot="state-chevron" data-open={expanded} aria-hidden="true" className={["v-state-chevron",className].filter(Boolean).join(" ")}>
    <m.span initial={false} animate={{rotate:expanded?(direction==="right"?90:180):0}} transition={quiet?{duration:0}:transition}><Icon name={direction==="right"?"chevron-right":"chevron-down"} size="sm" feedback={false} /></m.span>
  </span>;
}
export function StateChevron(props: StateChevronProps) {
  return <StateChevronImpl {...props} />;
}

// The static glyph with one-shot hover/focus/press feedback from its owning control (see useIconFeedback).
export { Icon as CojeevIcon, isKnownIcon };
export type { IconProps as CojeevIconProps };
