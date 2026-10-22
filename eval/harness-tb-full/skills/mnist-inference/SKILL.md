---
name: mnist-inference
description: Running a trained MNIST-style digit classifier (small MLP or CNN) on an image: input layout, choosing and verifying the pixel preprocessing when the checkpoint does not record it, and cross-checking a port against a reference forward pass.
---
# MNIST-style digit inference

## Input
- MNIST images are 28x28 grayscale. Check polarity by printing the pixel grid as ASCII rather than assuming it.
- Flatten row-major (top row first) into a 784-vector for an nn.Linear first layer. A CNN expects (1, 1, 28, 28).
- Pixel scaling is part of the model, and a checkpoint usually does not record it. Candidates to test: plain division by 255, or division by 255 then normalization with a mean and std (MNIST's commonly used values are 0.1307 and 0.3081). Read the model source first for any preprocessing it shows.

## Choosing preprocessing without metadata
- Run the same image through each candidate with a reference forward pass. Prefer the candidate with clearly higher top softmax probability on a clean digit. Near-uniform output suggests wrong preprocessing or wrong layer order.
- Report the chosen candidate and its confidence as an inference, not as a fact about the model.
- Don't build automatic heuristics (such as detecting polarity from the border) into the shipped tool unless the task asks for them.

## Forward pass
- nn.Linear computes y = x @ W.T + b, with W shaped [out, in]. Transposing this wrong is a common port bug.
- Apply ReLU only where the model source applies it. Final logits usually have no activation; the prediction is the argmax.

## Checking a port
- Compare the port with a pure-Python (or numpy, if present) forward pass on about 50 random inputs, and compare the argmax on each.
- If torch is available, loading the real model class gives an independent reference for the architecture. The preprocessing choice still needs its own justification.

## Image input
- 8-bit grayscale PNG: decode with the vendored decoder if present. If the image is not 28x28, state the resizing choice in the final answer.
