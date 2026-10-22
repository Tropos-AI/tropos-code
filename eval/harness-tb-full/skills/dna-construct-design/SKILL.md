---
name: dna-construct-design
description: Designing a DNA sequence (gBlock, insert or fusion gene) that encodes several protein domains joined by linkers for cloning into a plasmid. Covers reusing plasmid CDS, linker construction, codon choice to meet GC-window limits, and checks before writing the file.
---
# Designing a fusion-gene DNA sequence

## Reading the template plasmid
- A GenBank CDS location like 88..567 is 1-based and inclusive. Build the sequence from the ORIGIN block by deleting digits, spaces and line breaks, then check its length against LOCUS before slicing.
- Confirm the first codon is ATG and the last is a stop before cutting. To remove them, drop the first and last 3 nt.
- If the task says to reuse a protein's DNA, copy that slice verbatim. Do not back-translate it.

## Protein segments
- If the task says the vector's Met is reused, remove only the N-terminal Met of each segment.
- Keep PDB sequence features (tags, cleavage sites) when the task's matching rule requires an exact match. Resolve X from the structure's modified-residue records (see protein-db-lookup), not by guessing.

## Linkers
- A (GGGGS)n linker is 5n residues. Check the task's length limits.
- Give each linker different codons so identical DNA does not repeat.
- Place linkers only where the task allows, and never at a terminus the task forbids.

## Codon choice and GC windows
- E. coli-preferred codons for Gly, Pro, Ala, Ser and Leu are often G/C-rich, so glycine- and serine-rich linkers tend to break sliding-window GC limits. In one run a first back-translation had 174 of 2657 50-nt windows at 32-84% GC.
- GC count per codon, for choosing low-GC synonyms: Gly GGT/GGA 2, GGC/GGG 3; Ser TCT/AGT 1, TCA 1, AGC/TCC 2; Thr ACT/ACA 1, ACC 2; Pro CCT/CCA 2, CCC/CCG 3; Ala GCT/GCA 2, GCC/GCG 3; Leu TTA 0, TTG/CTT/CTA 1; Lys AAA 0, AAG 1; Glu GAA 1; Asp GAT 1; Arg AGA 1.
- When the limit is tight, build with low-GC synonyms from the start. If a window fails, swap synonymous codons only in editable regions near it. Re-check after every swap and translate to confirm the protein did not change.
- Random re-sampling alone can stall at the boundary. A small local search over synonymous codons reached a margin in one run.
- Aim for about 5 points of margin inside a hard limit.

## Checks before writing the file
- Translate the final DNA with the standard code and compare it with the expected concatenation of segment proteins, applying the Met rule the task states.
- Check: no internal stop codon; length a multiple of 3 when in frame; within the length limit; only A, C, G and T; no empty lines.
- Check that no 16-mer repeats across the sequence. Identical linker DNA is a common cause.
- If the cloning method is known, check both strands for its enzyme sites: BsaI GGTCTC (reverse complement GAGACC), BsmBI CGTCTC (GAGACG), NdeI CATATG, EcoRI GAATTC. Sites inside fixed DNA cannot be edited; say so in the report.
- Write a candidate to a scratch path and check it there. After copying to the final path, re-read the file and check it again.

Codon table helper (Python):
```python
import itertools
bases = 'TCAG'
aa = 'FFLLSSSSYY**CC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG'
CODE = {a + b + c: aa[i] for i, (a, b, c) in enumerate(itertools.product(bases, repeat=3))}
def translate(dna):
    return ''.join(CODE[dna[i:i+3]] for i in range(0, len(dna) - len(dna) % 3, 3))
```
