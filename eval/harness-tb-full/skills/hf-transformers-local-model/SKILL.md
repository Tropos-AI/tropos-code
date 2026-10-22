---
name: hf-transformers-local-model
description: Use when downloading a Hugging Face transformers model to a local directory, loading it for inference, or turning its logits into labels and confidence scores.
---
# Hugging Face transformers: local model and inference

Download and save
- mkdir -p the target directory. Load AutoTokenizer and AutoModelForSequenceClassification from the hub, then save_pretrained each one to the target.
- Check the directory afterwards: config.json, a weights file (model.safetensors or pytorch_model.bin), and the tokenizer files.
- Print model.config.id2label and num_labels right after loading, so the label mapping follows what the checkpoint declares.
- Model files are hundreds of MB. If the shell tool caps its timeout below the download time, run the download under nohup with a log file and poll the log.
- In the serving code, load from the local path with local_files_only=True, so a missing file fails instead of silently downloading.

Labels
- Map labels by name from model.config.id2label, never by an assumed index. Check num_labels is what you expect and raise an error otherwise.

Inference
- Call model.eval() and load the model once at import, not in each request handler.
- Tokenize with truncation=True and an explicit max_length so long input does not fail.
- Run the forward pass under torch.inference_mode(): logits = model(**inputs).logits.
- probs = torch.softmax(logits, dim=-1)[0]; convert each value with float(). For a two-class softmax the values sum to 1, a useful check.
- Reject empty or whitespace-only text before tokenizing; otherwise the model scores only special tokens.

Verify
- Run one clearly positive and one clearly negative sentence through the loaded model. Confirm the labels are right and every confidence lies between 0 and 1.
