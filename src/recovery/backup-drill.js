export function backupDrillPlan({ backupCommand, restoreCommand, verifyCommand }) {
  const steps = [
    ["CREATE_BACKUP", backupCommand],
    ["VERIFY_BACKUP", verifyCommand],
    ["RESTORE_ISOLATED", restoreCommand],
    ["VERIFY_RESTORED_DATA", "application-level integrity checks"]
  ];
  const ready = steps.every(([, command]) => typeof command === "string" && command.trim());
  return Object.freeze({ ready, steps: Object.freeze(steps.map(([name, command]) => Object.freeze({ name, command }))) });
}
