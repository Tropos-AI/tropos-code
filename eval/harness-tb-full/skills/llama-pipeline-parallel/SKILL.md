---
name: llama-pipeline-parallel
description: Splitting a Hugging Face Llama (decoder-only) model across torch.distributed ranks for pipeline-parallel forward and backward passes with point-to-point sends
---
# Pipeline-parallel Llama with torch.distributed

## Model layout
- LlamaForCausalLM: `model.model.embed_tokens`, `model.model.layers` (ModuleList of LlamaDecoderLayer), `model.model.norm`, `model.model.rotary_emb`, `model.lm_head`.
- Names and signatures change between transformers versions. Grep the installed `modeling_llama.py` before relying on them.

## Partitioning
- Give each rank a contiguous slice of decoder layers. Spread the remainder over the earliest ranks.
- Rank 0 runs the embedding. The last rank runs the final norm, lm_head and loss.
- Every rank must run a non-trivial number of layers. Print the per-rank count while testing.

## Calling a decoder layer
- In recent transformers, the decoder layer takes `hidden_states, attention_mask, position_ids, position_embeddings=(cos, sin)`.
- Every stage computes `position_embeddings` from its own `position_ids` with `model.model.rotary_emb(hidden, position_ids=pos)`, the same call LlamaModel.forward makes.
- Causal masking: check the signature of `create_causal_mask` (in `transformers.masking_utils`) in the installed version and call it the way LlamaModel.forward does. Eager attention adds the mask only when it is not None, so a None mask there means no causal masking. Compare eager and sdpa against a single-process reference rather than assuming either applies causality.

## Communication
- Hidden states are [microbatch, seq, hidden], with hidden taken from `model.config.hidden_size`. A receiving rank also needs the microbatch and sequence sizes: take them from its own inputs if it has them, or send them first. Do not assume every rank holds the first microbatch.
- Use `dist.P2POp` lists with `dist.batch_isend_irecv(ops)`, then wait on every returned request. Keep the send and recv order identical on both sides to avoid deadlock.
- Move inputs, hidden states and gradients to the target device and dtype before use.

## AFAB schedule (all forward, then all backward)
- Forward: for each microbatch in order, receive from the previous rank (if not first), run the local layers, send to the next rank (if not last). Keep each microbatch's graph alive for the backward pass.
- Make received tensors leaves that require grad, so their `.grad` can be sent back upstream.
- Backward: same microbatch order. The last stage calls `loss.backward()`. Other stages call `torch.autograd.backward(outputs, grad_tensors=recv_grad)`, then send the input's `.grad` to the previous rank.
- Loss scaling: if the spec says scale by the number of microbatches, multiply the per-microbatch cross-entropy by that count. Check whether targets are already shifted against logits, and compare the loss definition with the reference.

## Tied embeddings (`tie_word_embeddings=True`)
- The first rank (embedding) and the last rank (lm_head) share one weight. Each rank accumulates only its own gradient contribution.
- Before returning, the two ranks must sum the shared weight's gradient (a send/recv pair or an all_reduce over a two-rank group). Without this, the embedding gradient differs from the reference.
- With one rank, both uses are local, so no exchange is needed.

## Verifying
- Build a single-process reference from a deepcopy of the same weights. Compare per-layer outputs, the loss, and every parameter gradient.
- Test the world sizes the spec names, both attention implementations, tied and untied embeddings, and at least one uneven layer split. Run each command under `timeout`.
- Mutation check: disable one piece (for example the tied-gradient exchange) and confirm the affected cases fail.
