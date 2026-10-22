---
name: cipher-cryptanalysis
description: Use when recovering a key or breaking a cipher, hash or key schedule from encryption-oracle outputs (chosen-plaintext or differential attacks on Feistel, ARX or XOR-based ciphers), or when writing a key-search script for such a task.
---

# Cipher cryptanalysis

## Map the structure first
- Read the cipher code end to end. For each round, note which half is updated, which round key enters, and whether any key is used in only one round.
- In a Feistel network, a key used only in the last round can be reached from the ciphertext: undo the final output mixing to recover the state entering that round. Derive the exact output formula from the code; do not assume a standard one.
- Before building an attack on a model, reimplement the cipher from the code and check the model against the oracle on many random keys and inputs, not one fixed key.

## Differential search
- Treat the round function as a black box. For a candidate input difference d, count the most frequent value of F(x) ^ F(x ^ d) over about 2000 random x, and rank candidates by that count.
- Do not stop at single-byte differences. Also try differences that touch several bytes at once, built from a small set of byte patterns (for example 0x00, 0x01, 0x02, 0x40, 0x80, 0x81) in every byte position. A multi-byte difference can give an output difference with probability 1 while each single-byte difference holds only part of the time.
- Confirm a strong characteristic on a much larger sample (hundreds of thousands of inputs) before relying on it.
- Choose plaintext pairs so that differences cancel in the rounds you don't need. Derive the propagation by hand, then check it empirically.
- Recover the key by voting: for each candidate, count pairs where the predicted output difference holds. Record the best and second-best scores. A thin margin means the characteristic is weak: add pairs or find a better one.

## Key schedules
- If round keys come from a small seed, search the seed space instead of the full key space. Read the derivation from the code and reproduce it exactly, including width, masking and constants.

## Search cost in Python
- Time one candidate and one full run before any multi-trial test. Estimate the total as candidates x pairs x cost of one round call.
- Prune in stages: test each candidate on one or two pairs, keep only the survivors, and add pairs until a single candidate remains. Do not score every candidate on every pair.
- A multi-trial test can exceed the shell timeout. Size the trial count, or set the timeout, from the measured per-trial time.

## Verification
- Test on many random keys, and include a few edge values of the secret seed, since one fixed key can hide a bad threshold.
- Check the recovered value on pairs the search did not use.
- The attack may use only the oracle the task grants. Read the true secret only in test code, never inside the attack.
