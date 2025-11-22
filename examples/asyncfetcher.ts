// 1. Structural Types (What TS devs love)
interface GitHubUser {
  login: string;
  public_repos: number;
  followers: number;
}

interface GitHubRepo {
  name: string;
  stargazers_count: number;
}

// 2. The Logic
async function getUserSummary(username: string) {
  try {
    const baseUrl = `https://api.github.com/users/${username}`;

    // CONCURRENCY: Trigger both requests immediately without waiting
    // This is the "Async" stress test.
    const profileRequest = fetch(baseUrl);
    const reposRequest = fetch(`${baseUrl}/repos?sort=pushed&per_page=5`);

    // Wait for both to finish
    const [profileRes, reposRes] = await Promise.all([
      profileRequest,
      reposRequest
    ]);

    // Manual Error Checking (The friction point in TS/Fetch)
    if (!profileRes.ok) throw new Error(`Profile error: ${profileRes.status}`);
    if (!reposRes.ok) throw new Error(`Repos error: ${reposRes.status}`);

    // Parse JSON
    const user: GitHubUser = await profileRes.json();
    const repos: GitHubRepo[] = await reposRes.json();

    // Business Logic: Transformation
    const mostPopularRepo = repos.sort((a, b) => b.stargazers_count - a.stargazers_count)[0];

    return {
      status: "success",
      handle: user.login,
      totalRepos: user.public_repos,
      topRepo: mostPopularRepo ? mostPopularRepo.name : "No repos",
      starsOnTop: mostPopularRepo ? mostPopularRepo.stargazers_count : 0
    };

  } catch (error) {
    // Implicit Error Handling
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Unknown error"
    };
  }
}

// 3. Execution
(async () => {
  console.log("Fetching...");
  const result = await getUserSummary("torvalds");
  console.log(result);
})();