// Updated handleExportSummariesResult function with proper error handling
function handleExportSummariesResult(result) {
    if (!result.success) {
        showStatus(`Export failed: ${result.error || 'Unknown error'}`, 'error');
        return;
    }
    
    try {
        // Create a download link for the CSV data
        const blob = new Blob([result.data], { type: result.format === 'csv' ? 'text/csv' : 'application/json' });
        const url = URL.createObjectURL(blob);
        const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
        const fileExtension = result.format === 'csv' ? 'csv' : 'json';
        
        // Create link element and trigger download
        const a = document.createElement('a');
        a.href = url;
        a.download = `summaries-export-${today}.${fileExtension}`;
        document.body.appendChild(a);
        a.click();
        
        // Clean up
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 100);
        
        showStatus('Export successful! Download started.', 'success');
    } catch (error) {
        console.error('Error processing export:', error);
        showStatus('Failed to process export data', 'error');
    }
}