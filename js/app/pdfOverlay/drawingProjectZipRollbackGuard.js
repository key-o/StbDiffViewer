/**
 * Guard a failed ZIP cold-start cleanup against a newer model/file takeover.
 *
 * The ordinary model loader can fail before the caller records committedModel.
 * In that case we must compare the identity observed at failure with the
 * identity after the asynchronous cleanup import, not accept any model.
 */
export function ownsZipColdStartRollback({
  expectedEpoch,
  currentEpoch,
  installedFile,
  currentInputFile,
  otherInputFile,
  modelAAtFailure,
  currentModelA,
  modelBAtFailure,
  currentModelB,
  committedModel,
} = {}) {
  return Boolean(
    expectedEpoch === currentEpoch &&
    installedFile &&
    currentInputFile === installedFile &&
    !otherInputFile &&
    !modelBAtFailure &&
    modelAAtFailure === currentModelA &&
    modelBAtFailure === currentModelB &&
    (!committedModel || committedModel === modelAAtFailure),
  );
}
