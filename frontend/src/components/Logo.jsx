import React from "react";
export default function Logo({ size = 34, title = "EFL" }) { return <img src="/efl-logo.png" alt={title} height={size} style={{ display: "block", flexShrink: 0, height: size, width: "auto" }} />; }
