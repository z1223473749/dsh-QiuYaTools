using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace QiuYaTools.Windows;

// Single filesystem rename operation. No input, desktop, retry, delete or ACL relaxation.
internal static class AtomicJournalPublish
{
    private const uint DeleteAccess = 0x00010000;
    private const uint ShareReadWriteDelete = 0x00000007;
    private const uint OpenExisting = 3;
    private const uint OpenReparsePoint = 0x00200000;
    private const int FileRenameInfoEx = 22;
    private const uint ReplaceIfExistsAndPosix = 0x00000003;
    [StructLayout(LayoutKind.Sequential)]
    private struct RenameInfo { internal uint Flags; internal IntPtr RootDirectory; internal uint FileNameLength; internal ushort FileName; }
    [StructLayout(LayoutKind.Sequential)]
    private struct FileInfo { internal uint Attributes; internal System.Runtime.InteropServices.ComTypes.FILETIME Created; internal System.Runtime.InteropServices.ComTypes.FILETIME Accessed; internal System.Runtime.InteropServices.ComTypes.FILETIME Written; internal uint Volume; internal uint SizeHigh; internal uint SizeLow; internal uint Links; internal uint IndexHigh; internal uint IndexLow; }
    internal static int NameOffset => checked((int)Marshal.OffsetOf<RenameInfo>(nameof(RenameInfo.FileName)));
    internal static void Publish(string source, string destination)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        source = Path.GetFullPath(source); destination = Path.GetFullPath(destination);
        if (!string.Equals(Path.GetDirectoryName(source),Path.GetDirectoryName(destination),StringComparison.OrdinalIgnoreCase) || string.Equals(source,destination,StringComparison.OrdinalIgnoreCase)) throw new IOException("The journal rename must stay in its existing directory");
        using var handle=CreateFile(source,DeleteAccess,ShareReadWriteDelete,IntPtr.Zero,OpenExisting,OpenReparsePoint,IntPtr.Zero);
        if(handle.IsInvalid)ThrowLastError();
        if(!GetFileInformationByHandle(handle,out var file))ThrowLastError();
        if((file.Attributes & ((uint)FileAttributes.Directory | (uint)FileAttributes.ReparsePoint))!=0 || file.Links!=1)throw new IOException("The prepared journal must be a regular single-link file");
        var buffer=EncodeRenameInfo(destination);var memory=Marshal.AllocHGlobal(buffer.Length);
        try {
            // Zero padding and RootDirectory. Do not pass IGNORE_READONLY_ATTRIBUTE.
            Marshal.Copy(buffer,0,memory,buffer.Length);
            if(!SetFileInformationByHandle(handle,FileRenameInfoEx,memory,checked((uint)buffer.Length)))ThrowLastError();
        } finally {Marshal.FreeHGlobal(memory);}
    }
    internal static byte[] EncodeRenameInfo(string destination)
    {
        var name=Encoding.Unicode.GetBytes(destination);var offset=NameOffset;var buffer=new byte[checked(offset+name.Length+sizeof(ushort))];
        System.Buffers.Binary.BinaryPrimitives.WriteUInt32LittleEndian(buffer,ReplaceIfExistsAndPosix);
        System.Buffers.Binary.BinaryPrimitives.WriteUInt32LittleEndian(buffer.AsSpan(offset-sizeof(uint)),checked((uint)name.Length));
        name.CopyTo(buffer,offset);return buffer;
    }
    private static void ThrowLastError() { var error=Marshal.GetLastWin32Error();throw new IOException("The prepared journal could not be atomically renamed",unchecked((int)(0x80070000u | (uint)error))); }
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,EntryPoint="CreateFileW",SetLastError=true)]
    private static extern SafeFileHandle CreateFile(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
    [DllImport("kernel32.dll",SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle,out FileInfo information);
    [DllImport("kernel32.dll",SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetFileInformationByHandle(SafeFileHandle handle,int infoClass,IntPtr info,uint bytes);
}
