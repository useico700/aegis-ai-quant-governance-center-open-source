# Security
Never include secrets or account responses in public issues. Ask the repository owner for a private reporting channel without posting sensitive details.
Do not commit.env,.dev.vars,.runtime or production data. Review exports and dependency advisories before releases.
Default local-only access is deliberate. Do not expose CUSTOM_INTEGRATION, snapshot ingestion or account pages publicly without independent authentication and review.

Dependency review: see governance/dependency-review.json. Known residual upstream dependency advisories remain after compatible updates; this release is a local simulated/source distribution, not a production-security certification. Do not expose the dev server publicly. Recheck npm audit before custom deployment.
