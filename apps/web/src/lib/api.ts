import { OmniClient } from "@omni/api-client";

/** Same-origin in both dev (rewrite proxy) and single-origin deployments. */
export const api = new OmniClient("");
