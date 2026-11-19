/**
 * git's repository-steering variables, as a caller may have exported them (#1668).
 *
 * A git hook (`pre-commit`, `pre-push`) or a tool exports GIT_DIR, GIT_WORK_TREE,
 * GIT_INDEX_FILE, …; every `git` started with them works on THAT repository, not
 * on the one in its working directory. One list for every place that starts git
 * in a repository of its own choosing: `test-env.mjs` for a whole test run, the
 * git fixtures of single test files for a run without it (#1669), and the
 * code-roi runner for the suites of other repositories (#1670).
 *
 * The names: what `git rev-parse --local-env-vars` lists (git clears these
 * itself when it enters another repository), the KEY/VALUE pairs behind
 * GIT_CONFIG_COUNT, GIT_NAMESPACE, GIT_CEILING_DIRECTORIES and GIT_CONFIG_GLOBAL.
 * GIT_CONFIG_SYSTEM/NOSYSTEM stay: machine-wide, not the caller's, and Git for
 * Windows keeps required settings there. Names compare case-insensitively: on
 * Windows `git_dir` IS GIT_DIR, so the key is deleted as it is spelled.
 */
const CALLER_GIT_VARIABLE =
  /^GIT_(DIR|WORK_TREE|IMPLICIT_WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|GRAFT_FILE|NO_REPLACE_OBJECTS|REPLACE_REF_BASE|SHALLOW_FILE|PREFIX|NAMESPACE|CEILING_DIRECTORIES|CONFIG|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|CONFIG_GLOBAL)$/i;

/** Deletes those variables from `env` (this process's own by default) and returns it. */
export function dropCallerGitEnv(env = process.env) {
  for (const key of Object.keys(env)) if (CALLER_GIT_VARIABLE.test(key)) delete env[key];
  return env;
}
