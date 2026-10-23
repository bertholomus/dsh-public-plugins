---
project: quartz-cache
---
# Cluster layout

Six nodes: three in zone a and three in zone b. Keys are spread over the nodes with consistent hashing, and every key is kept on two nodes in different zones, so losing one zone loses no data.

Each node has 64 GB of memory, of which the cache may use 48 GB.
