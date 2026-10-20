# workspace

A Claude Code mod that lets one session work across several related repositories, like a VS Code multi-root workspace.

The workspace is a file in your main repo, `.claude/workspace.json`, which you can commit and share:

```json
{ "folders": [
  { "name": "api", "path": "../api", "repo": "owner/api" },
  { "name": "shared", "path": "../shared-models" }
] }
```

In a session opened in that repo, the mod:

- gives the session access to every folder (it adds them to `permissions.additionalDirectories` in `.claude/settings.local.json`, as `/add-dir` does);
- tells Claude, in the system prompt, to treat the repos as one project: search all of them, run git per repo with `git -C`, and commit and push each repo separately;
- shows a pane with each repo's branch, ahead/behind count and changed files, refreshed after every turn.

## Commands

| Command | What it does |
|---|---|
| `/workspace` | Open the pane and list the repos |
| `/workspace add ../api [name]` | Add a folder that is already on disk |
| `/workspace add owner/repo [name]` | Add a GitHub repo, cloned next to this one when missing |
| `/workspace remove <name>` | Take a repo out of the workspace; its files stay on disk |
| `/workspace sync` | Clone missing repos and refresh |
| `/workspace status` | Print each repo's branch and changes |

## Install

This repository is private: you need read access to it on GitHub, and a git credential for github.com on your machine (an SSH key, or `gh auth login` then `gh auth setup-git`).

At the prompt of a terminal session:

```
/plugin install workspace --marketplace galmc86/claude-workspace-mod
```

Answer `y` to add the marketplace, then pick a scope.

From a shell:

```
claude plugin install workspace --marketplace galmc86/claude-workspace-mod
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `galmc86/claude-workspace-mod`, then Add plugin.
