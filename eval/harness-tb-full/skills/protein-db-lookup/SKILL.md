---
name: protein-db-lookup
description: Fetching protein data from RCSB PDB and FPbase inside the sandbox: FASTA records, entry titles, chromophore and modified residues, antibody epitope identification by sequence search, and FPbase spectra. Use it whenever a task needs PDB or FPbase values.
---
# Looking up protein data

## Access
- `curl` may be missing. Use Python's `urllib.request` with a timeout and a plain agent-style User-Agent such as 'tcode'. One run got a 403 with a browser-style User-Agent. If you get a 403, check the header and retry once.
- Check which tools exist once, before a loop.
- Cache each large fetch to /tmp and reuse it.

## RCSB PDB
- FASTA for an entry: https://www.rcsb.org/fasta/entry/{ID}. Each entity gets its own record with chains and organism. Pick the record for the chain you need.
- Titles and entity names: https://data.rcsb.org/rest/v1/core/entry/{ID} (struct.title) and https://data.rcsb.org/rest/v1/core/polymer_entity/{ID}/{n} (rcsb_polymer_entity.pdbx_description).
- X in FASTA marks a non-standard residue. For the real residues, read https://files.rcsb.org/view/{ID}.cif: _entity_poly.pdbx_seq_one_letter_code_can and the _pdbx_modification_feature records give the three-letter components of chromophores. Use regex rather than printing the whole file. Cross-check against the FPbase sequence when one exists.
- Finding what an antibody binds: POST JSON to https://search.rcsb.org/rcsbsearch/v2/query with query type 'terminal', service 'sequence', and parameters containing value (the chain sequence), identity_cutoff near 0.9 and target 'pdb_protein_sequence'; set return_type to 'entry'. Search the variable domain rather than the full chain, since constant regions match many antibodies. If the schema errors, fix it against the docs. An entry that holds the antibody together with a peptide or small-molecule entity is the epitope. Confirm it by reading the entity names and the peptide sequence.

## FPbase
- Endpoint: https://www.fpbase.org/api/proteins/?format=json. The response may be a dict with 'results' and 'next', or a plain list. Accept both. Follow 'next' until it is null.
- Null fields are common. `pdb` and `states` can be None, so use `(p.get('pdb') or [])` and `(p.get('states') or [])`.
- Each state has name, ex_max and em_max in nm. Some states have no peak, so handle None. Multi-state proteins have names such as Green/Red or On/Off.
- Match entries to PDB IDs through the 'pdb' list and to names through 'name' and 'slug'. Several entries can share a name, so check the PDB link too.
