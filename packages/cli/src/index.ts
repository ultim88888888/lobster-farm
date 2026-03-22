import { Command } from "commander";
import { init_command } from "./commands/init.js";
import { start_command } from "./commands/start.js";
import { stop_command } from "./commands/stop.js";
import { status_command } from "./commands/status.js";
import { entity_command } from "./commands/entity.js";
import { update_command } from "./commands/update.js";

const program = new Command()
  .name("lf")
  .description("LobsterFarm — Autonomous Orchestration Platform")
  .version("0.1.0");

program.addCommand(init_command);
program.addCommand(start_command);
program.addCommand(stop_command);
program.addCommand(status_command);
program.addCommand(entity_command);
program.addCommand(update_command);

program.parse();
