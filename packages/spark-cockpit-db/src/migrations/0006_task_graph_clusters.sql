ALTER TABLE task_graph_threads RENAME TO task_graph_clusters;
ALTER TABLE task_graph_clusters RENAME COLUMN runtime_thread_id TO runtime_cluster_id;
ALTER TABLE task_graph_tasks RENAME COLUMN runtime_thread_id TO runtime_cluster_id;
