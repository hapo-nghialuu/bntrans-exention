# English frequency data provenance

`learning-frequency-data.js` contains the first 10,000 **unique lowercase ASCII
alphabetic tokens** (frequency order, counts removed) from
[`hermitdave/FrequencyWords` OpenSubtitles2018 English 50k list](https://github.com/hermitdave/FrequencyWords/blob/525f9b560de45753a5ea01069454e72e9aa541c6/content/2018/en/en_50k.txt)
at commit `525f9b560de45753a5ea01069454e72e9aa541c6`, by Hermit Dave and
OpenSubtitles/OPUS contributors. The upstream [README](https://github.com/hermitdave/FrequencyWords/blob/525f9b560de45753a5ea01069454e72e9aa541c6/README.md)
licenses **content** under [Creative Commons Attribution-ShareAlike 4.0
International (CC BY-SA 4.0)](https://creativecommons.org/licenses/by-sa/4.0/legalcode.en)
(code is MIT licensed). The derived `learning-frequency-data.js` is distributed
under **CC BY-SA 4.0**; attribution and the ShareAlike condition apply when
redistributing/adapting the data. No endorsement by the original authors is
implied. The surrounding extension code is separate from the data.

Processing change: exclude non-ASCII, punctuated, repeated, and numeric tokens;
preserve the remaining first 10,000 terms in their original order; omit counts.
The list measures subtitle frequency, **not learning difficulty or CEFR**. A
missing token is treated as rare; proper nouns, inflections and typos can be
misclassified. No remote lookup or per-word translation occurs.
