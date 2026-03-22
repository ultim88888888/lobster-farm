import { Command } from "commander";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export const update_command = new Command("update")
  .description("Pull latest code, rebuild, and relink")
  .action(() => {
    const src_dir = join(homedir(), ".lobsterfarm", "src");

    console.log("Updating LobsterFarm...\n");

    const steps = [
      { name: "Pulling latest", cmd: "git", args: ["pull"], cwd: src_dir },
      { name: "Installing deps", cmd: "pnpm", args: ["install"], cwd: src_dir },
      { name: "Building", cmd: "pnpm", args: ["build"], cwd: src_dir },
      { name: "Relinking CLI", cmd: "npm", args: ["link"], cwd: join(src_dir, "packages", "cli") },
    ];

    for (const step of steps) {
      console.log(`→ ${step.name}...`);
      const result = spawnSync(step.cmd, step.args, {
        cwd: step.cwd,
        stdio: "inherit",
      });

      if (result.status !== 0) {
        // Try with sudo for the link step
        if (step.name === "Relinking CLI") {
          console.log("  Retrying with sudo...");
          const retry = spawnSync("sudo", [step.cmd, ...step.args], {
            cwd: step.cwd,
            stdio: "inherit",
          });
          if (retry.status !== 0) {
            console.error(`  Failed: ${step.name}`);
            process.exit(1);
          }
        } else {
          console.error(`  Failed: ${step.name}`);
          process.exit(1);
        }
      }
    }

    console.log("\nUpdated. Restart the daemon with: lf stop && lf start");
  });
