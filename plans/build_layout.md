# Rough Individual Build layout

<this page should take the full pane, not be split view>

## Build Details

<this details are area should be collapsable>

<small text, compact table that has the following information information>

- Definition
- Project
- Status
- Branch
- Requester
- Repository
- Reason
- Started (from queued time)

## Build Details

<View similar to a folder display, with top level being stage, then all jobs below that stage at the next indentation level, then build tasks on top of it. keep it in the backpocket to show some sort of indicator that job A relies on job B. Each task in the list should be green (succeeded) or red (failed or cancelled) or gray (skipped,queued)>

Make each `task` in the little hierarchy of tasks a clickable link. When the user clicks it, it'll show a `Task` view on the other 50% of the main view.

This task view will automatically download the content of that task IF it is < 1MB size total. Otherwise present the a clickable link to download the load (with the size in parenthesis).

For _all_ of this stuff, if the build is completed, ALWAYS rely on the local cache of downloaded data. I mentioned that we should store the downloaded buildId artifacts right? yeah, when we click on a task in the `build` details pane, it should do that download (with additional link if bigger like I said before). Otherwise, it should JUST PRESENT THE TASK OUTPUT FROM THE LOCAL FOLDER CACHE.
