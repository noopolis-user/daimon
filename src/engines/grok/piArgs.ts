export const GROK_STRICT_SANDBOX_PROFILE = "strict";

export const renderGrokSandboxArgs = (
  commandArgs: readonly string[] | undefined,
  profile: string
): string[] => [...assertSafeGrokCommandArgs(commandArgs), "--sandbox", profile];

const assertSafeGrokCommandArgs = (args: readonly string[] | undefined): readonly string[] => {
  const values = args ?? [];
  if (values.some((value) => /^(?:--sandbox|--always-approve|--permission-mode|--leader-socket)(?:=|$)/u.test(value))) {
    throw new Error("Grok security-boundary arguments are Daimon-owned");
  }
  return values;
};

