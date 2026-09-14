/**
 * @deprecated Import the shared HTTP policy from `platform/http`.
 *
 * This compatibility export preserves existing internal imports while ownership of browser
 * request validation moves from the meetings domain to the shared HTTP platform boundary.
 */
export { TrustedBrowserRequestPolicy } from "../../platform/http/index.js";
