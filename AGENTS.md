# AGENTS

## Scope of this Project

- the devcontainer vscode extension is very useful for developing in sandboxed, isolated environments
- unfortunately, the devcontainer extension does not support slurm and apptainer
- goal of this project: a vscode extension `vscode-devcontainer-slurm`, which provides some of the functionality for slurm environments

## Users Perspective

Here is an example for the vision of the user's perspective:

- user connects to login node via ssh and runs a vscode session
- after adding configuration files (e.g., `.devcontainer-slurm`), user executes vscode command called, for example, `Open in slurm devcontainer`
- vsode will then submit a slurm job for development
- the slurm jub runs the apptainer container for development, to which vscode will connect and mount and open the project in `/workspaces/{project}` (similar to the actual devcontainer plugin)

## MVP

- keep it simple, if possible
- key functionality: simple way to start devcontainer sessions in slurm

## TODO

Track your todos in the `TODO.md` file.
