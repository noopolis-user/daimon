/** Same filter order and automatic secret exclusions for direct and brokered tools. */
export function shellEnvironmentPolicyEntries(env: Readonly<Record<string, string>>): readonly string[] {
  const set = Object.entries(env).map(([name, value]) => `${JSON.stringify(name)}=${JSON.stringify(value)}`).join(",");
  return ['inherit="all"', "ignore_default_excludes=false", "exclude=[]", "include_only=[]", `set={${set}}`];
}
