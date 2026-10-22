---
name: torch-checkpoint-no-torch
description: Reading or converting a PyTorch .pth/.pt checkpoint (torch.save state dict) without torch installed, for example to export weights to JSON or to a C array.
---
# Reading a torch checkpoint without torch

## File layout (torch.save, zip format)
- The file is a zip archive. Use `zipfile.ZipFile(path).namelist()` to list entries.
- `<prefix>/data.pkl` is a pickle describing the object. The prefix is a folder name that varies by file.
- `<prefix>/data/<key>` holds the raw bytes of one storage: no header, little-endian, contiguous. A float32 storage with n elements is 4*n bytes, so check the size.
- `<prefix>/version` and `<prefix>/byteorder` are metadata. Check that byteorder is little.

## Unpickling without torch
- Use a pickle.Unpickler subclass that overrides:
  - find_class(module, name): return stand-ins for torch._utils._rebuild_tensor_v2 (storage, storage_offset, size, stride, and extra args via *args, **kwargs), torch.<X>Storage (record the element type), and collections.OrderedDict (return the real class).
  - persistent_load(pid): pid is a tuple like ('storage', storage_type, key, location, numel). Return the bytes or a storage object for <prefix>/data/<key>.
- Map storage types to struct codes: FloatStorage to 'f' (float32), DoubleStorage to 'd', HalfStorage to 'e', LongStorage to 'q', IntStorage to 'i'.
- Build each tensor from the flat storage with struct.unpack('<%df' % numel, raw), then take storage_offset and walk size with stride. Saved state dicts are usually contiguous, but check that stride matches row-major.
- If unpickling fails, run pickletools.dis on the data.pkl bytes and read the GLOBAL lines. They name the classes you must map.

## Verifying
- Compare each tensor's shape with the model definition in the source (nn.Linear(in, out).weight is [out, in], bias is [out]). Read the source file instead of guessing the architecture.
- Check key names against the state dict's keys.

## Export
- Write JSON with nested lists in row-major order, one key per state-dict entry, using json.dump. Python's repr of a float keeps enough digits for float32 values.
