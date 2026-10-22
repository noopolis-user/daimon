import { shellEnvironmentPolicyEntries } from "../contracts/shellEnvironmentPolicy.js";

export function engineShellPolicy(env: Record<string, string>): string {
  return `{${shellEnvironmentPolicyEntries(env).join(",")}}`;
}
