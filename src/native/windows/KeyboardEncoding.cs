namespace QiuYaTools.Windows;

internal static class KeyboardEncoding
{
    // Bit 8 stores the E0 prefix in the journal; the low byte is the hardware scan code.
    internal static (ushort Scan, uint Flags) Encode(ushort code, bool up)
    {
        if (code > 511 || (code & 255) == 0) throw new NativeFailure("invalid-key", "Invalid hardware scan code");
        return ((ushort)(code & 255), 8u | ((code & 256) != 0 ? 1u : 0u) | (up ? 2u : 0u));
    }
}
