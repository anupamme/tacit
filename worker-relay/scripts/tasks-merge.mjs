// Job files hold a list of jobs: a builder replaces its own job by id and leaves the others as they are.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export const readJobs = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).jobs ?? [] : []);
export function writeJobs(path, job) {
  const jobs = readJobs(path);
  const at = jobs.findIndex((j) => j.id === job.id);
  if (at >= 0) jobs[at] = job; else jobs.push(job);
  writeFileSync(path, `${JSON.stringify({ jobs }, null, 2)}\n`);
}
