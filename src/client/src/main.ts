// Throwaway layout prototype behind `?layout=proto`; every other URL boots the normal Workbench shell.
if (new URLSearchParams(location.search).get("layout") === "proto") {
  document.querySelector("pi-workbench-app")?.replaceWith(document.createElement("workbench-layout-proto"));
  void import("./components/WorkbenchLayoutProto");
} else {
  void import("./components/WorkbenchApp");
}
