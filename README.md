# Atlas

Small business research & planning system.

## Architecture

- **Scribe**: Local RAG at :8765
- **Orchestrator**: Decomposes queries into parallel worker tasks
- **Workers**: Research individual dimensions
- **Context Store**: HOT/WARM/COLD three-tier tracking

## Run

```bash
pip install -r requirements.txt
export ANTHROPIC_API_KEY="sk-..."
python main.py
# Open http://127.0.0.1:8000
```

## Files

- scribe_client.py: HTTP client
- context_store.py: Source tracking
- prompts.py: System prompts
- main.py: FastAPI app
