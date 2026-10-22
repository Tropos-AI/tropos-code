---
name: bayes-net-causal
description: Use when recovering a Bayesian network DAG from tabular data, fitting a Bayesian network (especially linear-Gaussian with pgmpy), applying a do() intervention, or sampling from an intervened network.
---

# Bayesian networks: structure, fit, intervene, sample

## Recovering structure from continuous data
- Skeleton: for roughly Gaussian data, partial correlations come from the inverse covariance: pc_ij = -P_ij / sqrt(P_ii * P_jj). Test significance with Fisher z using n - |S| - 3 degrees of freedom, where S is the conditioning set.
- Marginal or all-variable partial correlations can mislead when colliders exist. Test each non-adjacent pair given the conditioning sets the candidate DAG implies.
- Check a candidate DAG with the local Markov property: regress each node on its parents with OLS and check that the residuals are uncorrelated with the non-descendants.
- If the brief states an edge count, compare the recovered skeleton with it. Use the count to settle a borderline edge, and say so in the report.
- Borderline dependence (p around 0.01 to 0.05): compare models before adding the edge. Adding one linear-Gaussian parameter must raise 2 * log-likelihood by more than ln(n); at n=10000 that is about 9.2. A likelihood-ratio statistic near 5 or 7 is not enough.
- If a dependence appears only under a linear fit and disappears when squared or interaction terms are added to the parents, treat it as misspecification rather than a missing edge, and report it.
- Orientation: from independence alone the data identifies only v-structures (A -> C <- B with A and B non-adjacent). Edges in no v-structure stay undetermined unless propagated with Meek's rules. If the task forces a choice, say in the report which edges the data did not decide. Several DAGs can tie on BIC when they differ only by such orientations; report the tie rather than calling one the unique answer.
- To check an orientation, list the v-structures it implies (get_immoralities() on a pgmpy DAG) and confirm they match the data.

## pgmpy (1.x) linear-Gaussian networks
- from pgmpy.models import LinearGaussianBayesianNetwork as LGBN. Edges are (parent, child) tuples, the reverse of a to,from CSV row. Flip them when reading or writing the file.
- Call model.add_nodes_from(df.columns) so root and isolated columns exist, then model.fit(df). Each node becomes N(sum of beta * parents + c, var); the coefficients equal per-node OLS, so you can cross-check with statsmodels.
- model.check_model() should return True. model.get_cpds() prints each fitted CPD.
- Check signatures with inspect.signature before use; they differ across versions.
- model.do(node, inplace=False) returns the mutilated graph with edges into the node removed. Write that graph out as the intervened DAG.
- Exact-value intervention: model.simulate(n_samples=N, do={'Y': 0.0}, seed=S) gives std 0 for Y. Use a tiny-variance substitute only if the library cannot do an exact value.
- Reorder the sampled columns to the input order before saving: sample[df.columns].

## Sanity checks
- Sample without intervention and compare correlations and means with the data. At 10k rows a max correlation gap around 0.01 to 0.02 is normal.
- A mean gap of several tenths at 10k rows can be sampling noise. Re-run with other seeds or a larger n (e.g. 200k) before treating it as a model error.
- After intervention the fixed node should have std 0 and the set value as its mean. Its descendants should shift as the graph implies; explain any large shift from the graph's structure.

## Environment
- A system Python may be PEP 668 externally-managed, so pip refuses installs. Check imports first.
- Prefer an isolated install: pip install --target <dir outside the project> with PYTHONPATH set. Venv creation can fail when python3-venv is missing.
- Use pip install --break-system-packages only if the isolated route fails and the task needs the package. Then say in the final answer exactly what was installed and where.