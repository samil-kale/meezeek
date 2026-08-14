/**
 * Generic "has enough output arrived to call the CLI ready" check, parameterized by agent-tuned
 * numbers — see each agent's createIsSessionReady for what they are and why. This file owns the
 * counting mechanism, not the tuning.
 */
export function createByteThresholdCheck(
  outputThreshold: number,
  graceMs = 0
): (chunk: string, elapsedMs: number) => boolean {
  let outputSinceGrace = 0;
  return (chunk, elapsedMs) => {
    if (elapsedMs <= graceMs) {
      return false;
    }
    outputSinceGrace += chunk.length;
    return outputSinceGrace > outputThreshold;
  };
}
