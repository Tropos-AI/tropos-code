// web/src/main.tsx — entry: styles, the store (real socket or ?demo=1), motion features, the app shell.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { domMax, LazyMotion, MotionConfig } from "motion/react";

import "@/styles/globals.css";

import { App } from "@/app/App";
import { isDemoMode } from "@/lib/demo";
import { createAppStore, StoreProvider } from "@/lib/store";

const store = createAppStore({ demo: isDemoMode() });
store.start();

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root");

createRoot(root).render(
  <StrictMode>
    <StoreProvider store={store}>
      {/* `m` components only (strict fails fast on a stray `motion.*`); domMax adds layout animations and drag. */}
      <LazyMotion features={domMax} strict>
        <MotionConfig reducedMotion="user">
          <App />
        </MotionConfig>
      </LazyMotion>
    </StoreProvider>
  </StrictMode>,
);
