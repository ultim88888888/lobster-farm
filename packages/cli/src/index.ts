import { Command } from "commander";
import { init_command } from "./commands/init.js";
import { start_command } from "./commands/start.js";
import { stop_command } from "./commands/stop.js";
import { status_command } from "./commands/status.js";

const program = new Command()
  .name("lobsterfarm")
  .description("LobsterFarm — Autonomous Software Consultancy CLI")
  .version("0.1.0");

program.addCommand(init_command);
program.addCommand(start_command);
program.addCommand(stop_command);
program.addCommand(status_command);

program.parse();
